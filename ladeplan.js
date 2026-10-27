// Ladeplan: pure planning logic (no DOM, no storage, no network), shared by index.html and the tests.
// All times are device-local, which is assumed to be Danish time.
/* ---------- settings ---------- */
const H = 3600e3;
const DEF = {
  car: "ID.3",                         // shown in the header only
  soc: 50, kmOneWay: 39, depart: "07:30", home: "17:00",
  pattern: [1,1,1,1,0,0,0],           // Mon..Sun, 1 = commute
  battery: 58, reserve: 10, maxSoc: 80, chargerKw: 11, effPct: 90, cheapFill: 0,
  fillCheap: true,                     // top up to the charge limit in known hours that are cheap vs. recent days
  oneWindowKr: 5,                      // accept up to this many kr extra to charge in one timer window
  cons: { s: 14, h: 17, w: 20 },        // kWh/100 km: summer, shoulder, winter
  seasons: "wwwhhssshhww",             // Jan..Dec
  area: "DK1",
  // Grid tariff: N1 C-customer rates from 1 Jan 2026 (n1.dk), converted from øre incl. VAT to kr excl. VAT
  t: { winter: { night: 0.08784, day: 0.2636, peak: 0.79072 },   // Oct–Mar: 10.98 / 32.95 / 98.84 øre incl. VAT
       summer: { night: 0.08784, day: 0.13176, peak: 0.34264 },  // Apr–Sep: 10.98 / 16.47 / 42.83 øre incl. VAT
       energinet: 0.14, elafgift: 0.008, supplier: 0.05 },
  overrides: {},                       // "YYYY-MM-DD" -> round-trip km
  socAt: null,                         // ms when soc was last set (by a reading, "Use" or moved forward by rollLevel())
  readAt: null, readSoc: null,         // the last reading of the car (slider moved), for the consumption log
  planned: [],                         // [start,end] ms of charging windows shown since then (assumed done)
  errands: [],                         // { at, km }: drives outside the commute ("Extra drive"), see setErrand()
  socLog: [],                          // readings after drives, for tuning consumption later
  history: [], histAt: null,           // what happened (drives, charging, readings, level set), see recordHistory()
  commit: null                         // session choice: { kind: plan|manual|none, until, windows, limit, at }
};
const STORE = "ladeplan.v1";
const LOG_MAX = 60;
const HIST_DAYS = 120;
const HIST_KINDS = ["drive","charge","reading","level"];
const CAR_MAX = 24;
// Allowed range per numeric setting; out-of-range values are clamped, non-numbers fall back to the default.
const LIMITS = {
  soc:[0,100], kmOneWay:[0,500], battery:[10,200], reserve:[0,50], maxSoc:[50,100], chargerKw:[1,22], effPct:[50,100], cheapFill:[0,5], oneWindowKr:[0,50],
  "cons.s":[5,50], "cons.h":[5,50], "cons.w":[5,50],
  "t.winter.night":[0,5], "t.winter.day":[0,5], "t.winter.peak":[0,5], "t.summer.night":[0,5], "t.summer.day":[0,5], "t.summer.peak":[0,5], "t.energinet":[0,5], "t.elafgift":[0,5], "t.supplier":[-1,5]
};
function clone(o){ return JSON.parse(JSON.stringify(o)); }
function getPath(o,p){ return p.split(".").reduce((a,k)=>a[k], o); }
function setPath(o,p,v){ const ks=p.split("."); const last=ks.pop(); ks.reduce((a,k)=>a[k], o)[last]=v; }
function clampSetting(k, v){
  const [lo,hi]=LIMITS[k];
  return typeof v==="number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : getPath(DEF,k);
}
// Earlier default grid tariffs (rough estimates); a season still set to one of these was never edited.
const OLD_GRID_DEFAULTS = [{ night: 0.15, day: 0.30, peak: 0.70 }, { night: 0.10, day: 0.15, peak: 0.35 }];
// Before seasonal tariffs, t had flat night/day/peak; keep them for both seasons so nothing changes.
function migrateTariffs(t){
  if (t.night!=null || t.day!=null || t.peak!=null){
    const flat={ night:t.night, day:t.day, peak:t.peak };
    t.winter=Object.assign({}, t.winter, flat); t.summer=Object.assign({}, t.summer, flat);
    delete t.night; delete t.day; delete t.peak;
  }
  t.winter=Object.assign(clone(DEF.t.winter), t.winter); t.summer=Object.assign(clone(DEF.t.summer), t.summer);
  for (const k of ["winter","summer"]){
    const g=t[k];
    if (OLD_GRID_DEFAULTS.some(o=>o.night===g.night && o.day===g.day && o.peak===g.peak)) t[k]=clone(DEF.t[k]);
  }
  return t;
}
// Settings from the stored JSON string (or null); pure, so the page reads storage and the tests don't need to.
function settingsFrom(raw){
  let s = clone(DEF);
  try { if (raw){ const p = JSON.parse(raw); s = Object.assign(s, p); s.t = migrateTariffs(Object.assign(clone(DEF.t), p.t || {})); s.cons = Object.assign(clone(DEF.cons), p.cons || {}); delete s.kwhPer100; if (!/^[shw]{12}$/.test(s.seasons)) s.seasons = DEF.seasons; } } catch(e){}
  for (const k in LIMITS) setPath(s, k, clampSetting(k, getPath(s,k)));
  s.car = typeof s.car==="string" ? s.car.trim().slice(0, CAR_MAX) : DEF.car;
  if (!["DK1","DK2"].includes(s.area)) s.area = DEF.area;
  if (typeof s.fillCheap!=="boolean") s.fillCheap = DEF.fillCheap;
  const num=Number.isFinite;
  if (!num(s.socAt)) s.socAt=null;
  // Before readAt existed, every level set counted as a reading
  if (!num(s.readAt) || !num(s.readSoc)){ s.readAt=s.socAt; s.readSoc=s.socAt==null ? null : s.soc; }
  else s.readSoc=Math.min(100, Math.max(0, s.readSoc));
  const win=w=>Array.isArray(w) && num(w[0]) && num(w[1]) && w[0]<w[1];
  s.planned=Array.isArray(s.planned) ? s.planned.filter(w=>win(w) && (w.length===2 || (w.length===3 && w[2]===1))) : [];
  s.errands=Array.isArray(s.errands) ? s.errands.filter(e=>e && num(e.at) && num(e.km) && e.km>0).slice(-50) : [];
  const c=s.commit;
  s.commit = c && ["plan","manual","none"].includes(c.kind) && num(c.until) && num(c.at) && Array.isArray(c.windows)
    && c.windows.every(w=>win(w) && w.length===2) && (c.kind==="none" || (num(c.limit) && c.limit>=50 && c.limit<=100))
    ? { kind:c.kind, until:c.until, windows:c.windows, limit:c.kind==="none" ? null : c.limit, at:c.at } : null;
  s.history=Array.isArray(s.history) ? s.history.filter(e=>e && HIST_KINDS.includes(e.k) && num(e.at)).slice(-2000) : [];
  if (!num(s.histAt)) s.histAt=null;
  s.socLog=Array.isArray(s.socLog) ? s.socLog.filter(e=>e && num(e.at) && num(e.from) && num(e.km) && num(e.predKwh) && num(e.startKwh)).slice(-LOG_MAX) : [];
  return s;
}

/* ---------- time helpers (device local time = Danish time) ---------- */
const pad = n => String(n).padStart(2,"0");
const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const shortDay = (t, now) => dateKey(new Date(t))===dateKey(now) ? "Today" : DOW[new Date(t).getDay()];
const monIdx = d => (d.getDay()+6)%7;
function atTime(day, hhmm){ const [h,m]=hhmm.split(":").map(Number); const d=new Date(day); d.setHours(h,m,0,0); return d; }
function startOfDay(d){ const x=new Date(d); x.setHours(0,0,0,0); return x; }
function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
// Car and wallbox timers take 5-minute steps: starts round down, ends round up, so there's never less charging
// time than planned. 1 s of slack absorbs float noise from the duration arithmetic.
const round5 = (t, up) => { const m=5*60e3; return up ? Math.ceil((t-1000)/m)*m : Math.floor((t+1000)/m)*m; };
const hm5 = (t, up) => hhmm(round5(t, up));
const hhmm = t => { const d=new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function dayLabel(t, now){
  const d0=startOfDay(now).getTime(), d=startOfDay(new Date(t)).getTime();
  const diff=Math.round((d-d0)/864e5);
  return diff===0?"Today":diff===1?"Tomorrow":DOW[new Date(t).getDay()];
}

/* ---------- consumption ---------- */
const SEASON = { s:"Summer", h:"Shoulder", w:"Winter" };
const consFor = (day, s) => s.cons[s.seasons[new Date(day).getMonth()]];

/* ---------- prices ---------- */
const isTariffWinter = t => { const m=new Date(t).getMonth(); return m>=9 || m<=2; };   // Oct–Mar
function tariff(t, s){
  const d=new Date(t), h=d.getHours(), g=isTariffWinter(t) ? s.t.winter : s.t.summer;
  return h<6 ? g.night : (h>=17 && h<21) ? g.peak : g.day;
}
// Final price per kWh split into its parts, each incl. 25% VAT, in kr/kWh. fees = everything except spot.
function priceParts(spotMWh, t, s){
  const v=1.25, p={ spot:spotMWh/1000*v, grid:tariff(t,s)*v, energinet:s.t.energinet*v, elafgift:s.t.elafgift*v, supplier:s.t.supplier*v };
  p.fees=p.grid+p.energinet+p.elafgift+p.supplier; p.total=p.spot+p.fees;
  return p;
}
function totalPrice(spotMWh, t, s){ return priceParts(spotMWh,t,s).total; }

/* ---------- forecast model ---------- */
const wpow = ws => Math.min(1, Math.max(0, (ws-3)/9));   // rough wind-turbine output curve, 0..1
function features(t, w){
  const d=new Date(t), h=d.getHours(), dow=d.getDay();
  const f=[1, w.wind, w.wind*w.wind, w.solar, w.temp, (dow===0||dow===6)?1:0];
  for (let i=1;i<24;i++) f.push(h===i?1:0);
  return f;
}
function solve(A,b){
  const n=b.length, M=A.map((r,i)=>[...r,b[i]]);
  for (let c=0;c<n;c++){
    let p=c; for (let r=c+1;r<n;r++) if (Math.abs(M[r][c])>Math.abs(M[p][c])) p=r;
    [M[c],M[p]]=[M[p],M[c]];
    const piv=M[c][c]||1e-12;
    for (let r=0;r<n;r++){ if(r===c) continue; const f=M[r][c]/piv; if(!f) continue; for (let k=c;k<=n;k++) M[r][k]-=f*M[c][k]; }
  }
  return M.map((r,i)=>r[n]/(r[i]||1e-12));
}
function fitModel(rows, nowMs){
  // rows: [{t, x:[...], y}] ; recency-weighted ridge regression
  const p=rows[0].x.length, A=Array.from({length:p},()=>new Array(p).fill(0)), b=new Array(p).fill(0);
  const halfLife=7*24*H;
  for (const r of rows){
    const w=Math.pow(0.5,(nowMs-r.t)/halfLife);
    for (let i=0;i<p;i++){ b[i]+=w*r.x[i]*r.y; for (let j=0;j<p;j++) A[i][j]+=w*r.x[i]*r.x[j]; }
  }
  for (let i=1;i<p;i++) A[i][i]+=2;    // light ridge, intercept free
  const beta=solve(A,b);
  const pred=x=>x.reduce((a,v,i)=>a+v*beta[i],0);
  let se=0, ae=0, n=0;
  for (const r of rows){ if (nowMs-r.t>7*24*H) continue; const e=r.y-pred(r.x); se+=e*e; ae+=Math.abs(e); n++; }
  return { pred, sigma: Math.sqrt(se/Math.max(1,n)), mae: ae/Math.max(1,n), n: rows.length };
}

/* ---------- data fetch ---------- */
// One file per day from elprisenligenu.dk: [{DKK_per_kWh, time_start:"…+02:00"}], spot excl. VAT.
// Returns Map(UTC hour ms -> DKK/MWh); sub-hourly records are averaged.
function parsePrices(days){
  const acc=new Map();
  for (const recs of days) for (const rec of recs||[]){
    if (rec.DKK_per_kWh==null) continue;
    const t=Math.floor(Date.parse(rec.time_start)/H)*H;
    if (!isFinite(t)) continue;
    const a=acc.get(t)||[0,0]; a[0]+=rec.DKK_per_kWh*1000; a[1]++; acc.set(t,a);
  }
  const m=new Map(); for (const [t,[s,n]] of acc) m.set(t,s/n); return m;
}
function demoData(now){
  const prices=new Map(), weather=new Map();
  const t0=Math.floor(addDays(now,-22).getTime()/H)*H, t1=startOfDay(addDays(now,3)).getTime();
  const cut = now.getHours()>=13 ? startOfDay(addDays(now,2)).getTime() : startOfDay(addDays(now,1)).getTime();
  let seed=7; const rnd=()=>{ seed=(seed*16807)%2147483647; return seed/2147483647-0.5; };
  for (let t=t0;t<t1;t+=H){
    const d=new Date(t), h=d.getHours();
    const wind=Math.min(1,Math.max(0,0.5+0.45*Math.sin(t/(H*29))+0.2*Math.sin(t/(H*71))));
    const solar=Math.max(0,Math.sin((h-7)/10*Math.PI))*0.35;
    const temp=0.9+0.3*Math.sin(t/(H*120));
    weather.set(t,{wind,solar,temp});
    const prof=[-.15,-.2,-.22,-.22,-.18,-.05,.15,.3,.25,.1,0,-.05,-.08,-.05,0,.08,.2,.35,.4,.3,.15,.05,-.02,-.1][h];
    const wk=(d.getDay()===0||d.getDay()===6)?-120:0;
    if (t<cut) prices.set(t, Math.max(-50, 1050 - 950*wind - 500*solar + 600*prof + wk + 80*rnd()));
  }
  return {prices, weather};
}

/* ---------- build hours and plan ---------- */
function buildHours(prices, weather, s, now){
  const nowMs=now.getTime();
  const rows=[];
  for (const [t,y] of prices){ const w=weather.get(t); if (w) rows.push({t, x:features(t,w), y}); }
  const model = rows.length>200 ? fitModel(rows, nowMs) : null;
  const startH=Math.floor(nowMs/H)*H;
  const end=startOfDay(addDays(now,3)).getTime();
  const hours=[];
  for (let t=startH;t<end;t+=H){
    let spot=prices.get(t), fc=false, sig=0;
    if (spot==null){
      const w=weather.get(t); if(!w || !model) continue;
      spot=model.pred(features(t,w)); fc=true;
      sig=model.sigma*Math.min(1.6, 1+(t-startH)/(72*H));   // uncertainty grows with lead time
    }
    const parts=priceParts(spot,t,s);
    hours.push({ t, spot, fc, parts, price: parts.total, sigma: sig/1000*1.25 });
  }
  return { hours, model };
}

// Round-trip km from the weekly pattern alone (0 = car home all day)
function patternKm(day, s){ return s.pattern[monIdx(day)] ? 2*s.kmOneWay : 0; }
// Round-trip km on a date: per-date override, else the weekly pattern (0 = car home all day)
function kmOn(day, s){ const key=dateKey(day); return s.overrides[key]!=null ? s.overrides[key] : patternKm(day, s); }
// The commute on a date: round-trip km, departure and return (ms). The car is away between dep and back if km>0.
function commuteOn(day, s){ return { key:dateKey(day), km:kmOn(day, s), dep:atTime(day,s.depart).getTime(), back:atTime(day,s.home).getTime() }; }
// Energy for km driven on a date, at that date's season consumption
const kwhFor = (km, day, s) => km*consFor(day, s)/100;

function drivesFor(s, now, horizonEnd){
  const ev=[];
  for (let i=0;i<4;i++){
    const day=addDays(startOfDay(now),i), {key, km, dep, back}=commuteOn(day, s);
    if (km<=0 || dep>=horizonEnd) continue;
    if (dep>now.getTime()) ev.push({t:dep, back, km, need:kwhFor(km,day,s), key, check:true});
    else if (back>now.getTime()) ev.push({t:back, back, km:km/2, need:kwhFor(km,day,s)/2, key, check:false, returning:true});
  }
  // Errands later today or on a later day: a drive at that moment that must also keep the reserve. Only the hour it
  // starts in counts as away (back just after t), which also keeps charging from being moved across it.
  for (const e of s.errands) if (e.at>now.getTime() && e.at<horizonEnd)
    ev.push({t:e.at, back:e.at+60e3, km:e.km, need:kwhFor(e.km,new Date(e.at),s), key:dateKey(new Date(e.at)), check:true, errand:true});
  return ev;
}

// fillBelow (kr/kWh, from cheapLimit()): also top up to the charge limit in known-price hours below it.
function plan(hours, s, now, fillBelow=null){
  const nowMs=now.getTime(), B=s.battery, eff=s.effPct/100;
  // Start from the level now: the level set, plus charging planned and drives made since (levelEst())
  const est=levelEst(s, now), res=B*s.reserve/100, soc0=est ? est.kwh : B*s.soc/100;
  const end = hours.length ? hours[hours.length-1].t+H : nowMs;
  const events=drivesFor(s, now, end).sort((a,b)=>a.t-b.t);
  // Energy that must be charged before the next departure to keep the reserve, whatever the price.
  const nextDrive=events.find(e=>e.check);
  let mustKwh=0, noChargeLvl=null;
  if (nextDrive){
    let used=0; for (const e of events){ used+=e.need; if (e===nextDrive) break; }
    noChargeLvl=soc0-used; mustKwh=Math.max(0, res-noChargeLvl);
  }
  const away=(t0,t1)=>events.some(e=>{ const dep=e.returning?nowMs:e.t; return t0<e.back && t1>dep; });
  const slots=hours.map(h=>{
    const st=Math.max(h.t,nowMs), frac=(h.t+H-st)/H;
    return {...h, home:!away(h.t,h.t+H), capK:s.chargerKw*eff*frac, charge:0, rank:h.price+(h.fc?0.5*h.sigma:0)};
  });
  // A session the user chose (s.commit) is fixed until the car leaves: those slots get the chosen windows'
  // energy, stopped at the chosen limit, and the planner doesn't touch them. A deficit before then stays short.
  const commit = s.commit && s.commit.until>nowMs ? s.commit : null;
  if (commit){
    const kw=s.chargerKw*eff, cap=commit.limit!=null ? B*commit.limit/100 : B;
    let lvl=soc0, ei=0;
    for (const sl of slots){
      if (sl.t>=commit.until) break;
      while (ei<events.length && events[ei].t<=sl.t){ lvl-=events[ei].need; ei++; }
      sl.locked=true;
      const a=Math.max(sl.t,nowMs), b=sl.t+H;
      let dur=0, x=null;
      for (const [w0,w1] of commit.windows){ const o0=Math.max(a,w0), o1=Math.min(b,w1); if (o1>o0){ dur+=o1-o0; if (x==null) x=o0; } }
      const amt=sl.home ? Math.min(dur/H*kw, Math.max(0, cap-lvl)) : 0;
      if (amt>0.01){ sl.charge=amt; sl.at=[x, x+amt/kw*H]; lvl+=amt; }
    }
  }
  const free=i=>slots[i].home && !slots[i].locked;
  function sim(){
    let lvl=soc0, ei=0; const after=[], before=[];
    for (let i=0;i<slots.length;i++){
      while (ei<events.length && events[ei].t<=slots[i].t){ before[ei]=lvl; lvl-=events[ei].need; ei++; }
      lvl+=slots[i].charge; after[i]=lvl;
    }
    while (ei<events.length){ before[ei]=lvl; lvl-=events[ei].need; ei++; }
    return {after, before, endLvl:lvl};
  }
  function headroom(i, cap){ const {after}=sim(); let mx=-Infinity; for (let j=i;j<after.length;j++) mx=Math.max(mx,after[j]); return cap-mx; }
  const order = idx => idx.sort((a,b)=>slots[a].rank-slots[b].rank);
  events.forEach((ev,k)=>{
    if (!ev.check) return;
    for (const cap of [B*s.maxSoc/100, B]){
      let def=res+ev.need-sim().before[k];
      if (def<=0.01) break;
      const cand=order(slots.map((_,i)=>i).filter(i=>free(i) && slots[i].t+H<=ev.t));
      for (const i of cand){
        if (def<=0.01) break;
        const amt=Math.min(slots[i].capK-slots[i].charge, def, headroom(i,cap));
        if (amt>0.01){ slots[i].charge+=amt; def-=amt; }
      }
      ev.short = def>0.05 ? def : 0;
    }
  });
  // Top-ups: below the always-fill price, or (known prices only) cheap compared with recent days.
  // sl.fill keeps the extra energy so the card can say why it charges more than needed.
  const cheap=sl=>(s.cheapFill>0 && sl.price<=s.cheapFill) || (fillBelow!=null && !sl.fc && sl.price<fillBelow);
  for (const i of order(slots.map((_,i)=>i).filter(i=>free(i) && cheap(slots[i])))){
    const amt=Math.min(slots[i].capK-slots[i].charge, headroom(i,B*s.maxSoc/100));
    if (amt>0.01){ slots[i].charge+=amt; slots[i].fill=amt; }
  }
  // Prices are fixed per hour, so only the energy in each hour matters. In each run of consecutive charging
  // hours, move charge so at most one hour is partly used and it sits at one end of the run (whichever is
  // cheaper, and only if that doesn't cost more). The run then maps to one unbroken timer window.
  for (const sl of slots) if (sl.charge<=0.01) sl.charge=0;
  const runs=[]; let run=null;
  slots.forEach((sl,i)=>{ if (sl.charge>0){ if (run && run[run.length-1]===i-1) run.push(i); else runs.push(run=[i]); } else run=null; });
  for (const r of runs){
    if (r.length<2 || r.some(i=>slots[i].locked)) continue;
    const E=r.reduce((a,i)=>a+slots[i].charge,0), cost=m=>r.reduce((a,i)=>a+m(i)*slots[i].price,0);
    const fill=idx=>{ let left=E; const m=new Map(); for (const i of idx){ const v=Math.min(slots[i].capK,left); m.set(i,v); left-=v; } return i=>m.get(i); };
    const now_=i=>slots[i].charge, fwd=fill(r), back=fill([...r].reverse());
    const best=[fwd,back].reduce((x,y)=>cost(y)<cost(x)-1e-9?y:x);
    if (cost(best)<=cost(now_)+1e-9) for (const i of r) slots[i].charge=best(i)>0.01?best(i):0;
  }
  // Charging windows with exact times. A partly used hour charges at its end when the next hour also charges
  // (so the window is unbroken), otherwise at its start.
  const windows=()=>{
    const out=[]; let cur=null;
    slots.forEach((sl,i)=>{
      if (!(sl.charge>0)){ cur=null; return; }
      const a=Math.max(sl.t,nowMs), b=sl.t+H, dur=sl.charge/(s.chargerKw*eff)*H;
      const prev=i>0 && slots[i-1].charge>0, next=i+1<slots.length && slots[i+1].charge>0;
      const [x,y] = sl.at ? sl.at : dur>=b-a-1000 ? [a,b] : (!prev && next) ? [b-dur,b] : [a,a+dur];
      const grid=sl.charge/eff, cost=grid*sl.price;
      if (cur && Math.abs(cur.end-x)<1000){ cur.end=y; cur.kwh+=grid; cur.cost+=cost; cur.fc=cur.fc||sl.fc; cur.idx.push(i); }
      else { cur={start:x, end:y, kwh:grid, cost, fc:sl.fc, idx:[i]}; out.push(cur); }
    });
    return out;
  };
  // One timer window is easier to set up: merge neighbouring windows when the car is home in between and the
  // cheaper of front- or back-filling the span costs less than s.oneWindowKr more.
  const MERGE_KR=s.oneWindowKr;
  for (let guard=0; guard<50; guard++){
    const w=windows(); let merged=false;
    for (let k=1;k<w.length && !merged;k++){
      const span=[]; for (let i=w[k-1].idx[0]; i<=w[k].idx[w[k].idx.length-1]; i++) span.push(i);
      if (span.some(i=>!free(i))) continue;
      const E=span.reduce((x,i)=>x+slots[i].charge,0), cur=span.reduce((x,i)=>x+slots[i].charge*slots[i].price,0);
      let best=null;
      for (const list of [span, [...span].reverse()]){
        let left=E, c=0; const m=new Map();
        for (const i of list){ const v=Math.min(slots[i].capK,left); m.set(i,v); c+=v*slots[i].price; left-=v; }
        if (left<=0.01 && (!best || c<best.c)) best={c,m};
      }
      if (best && (best.c-cur)/eff < MERGE_KR){ for (const i of span) slots[i].charge=best.m.get(i)>0.01?best.m.get(i):0; merged=true; }
    }
    if (!merged) break;
  }
  const {before, endLvl, after}=sim();
  slots.forEach((sl,i)=>{ sl.lvl=after[i]; });
  events.forEach((e,k)=>{ e.lvlBefore=before[k]; e.lvlAfter=before[k]-e.need; });
  const blocks=windows().map(w=>({ start:w.start, end:w.end, kwh:w.kwh, cost:w.cost, fc:w.fc, lvlEnd:slots[w.idx[w.idx.length-1]].lvl, hours:w.idx.length }));
  return { slots, events, blocks, endLvl, B, soc0, nextDrive, mustKwh, noChargeLvl, res, commit };
}

/* ---------- battery level after a drive ---------- */
const DAY = 864e5;
// Drives between `from` and `to`, as legs: the whole trip ("day") if it left after `from` and is back by `to`;
// half if `from` fell while the car was away ("back", same rule as drivesFor()) or the car is still away at `to`
// ("out": the drive to work counts as done once the departure time has passed). Errands (s.errands) are legs
// of their own ("errand") at their time. Sorted by when each leg ended.
function drivesDone(s, from, to){
  const out=[];
  for (let day=startOfDay(new Date(from)); day.getTime()<=to; day=addDays(day,1)){
    const {key, km, dep, back}=commuteOn(day, s); if (km<=0) continue;
    const leg = dep>from && back<=to ? "day" : dep<=from && back>from && back<=to ? "back" : dep>from && dep<=to && back>to ? "out" : null;
    if (!leg) continue;
    const part=leg==="day" ? 1 : 0.5;
    out.push({ key, back, leg, km:km*part, cons:consFor(day, s), kwh:kwhFor(km*part, day, s) });
  }
  for (const e of s.errands) if (e.at>from && e.at<=to){
    const day=new Date(e.at);
    out.push({ key:dateKey(day), back:e.at, leg:"errand", km:e.km, cons:consFor(day, s), kwh:kwhFor(e.km, day, s) });
  }
  return out.sort((a,b)=>a.back-b.back);
}
// Charging windows the app has shown, kept so a later estimate can assume they were used. The part of each
// stored window before `now` stays (back to socAt or the last reading, max 14 days); from `now` on, the current plan's windows before the
// next departure replace them. Windows the user chose (P.commit) are marked with a third element 1.
// A running window is cut at `now` on every recompute; touching windows of the same kind are joined again, so it
// stays one window (recordHistory() records it whole once it ends).
function notePlanned(planned, P, now, s){
  const t=now.getTime(), from=Math.max(Math.min(s.socAt||t, s.readAt||t), t-14*DAY), leave=P.nextDrive ? P.nextDrive.t : Infinity;
  const past=planned.filter(([a,b])=>a<t && b>from).map(([a,b,c])=>c ? [a, Math.min(b,t), 1] : [a, Math.min(b,t)]);
  const chosen=b=>P.commit && b.start<P.commit.until;
  const all=[...past, ...P.blocks.filter(b=>b.start<leave).map(b=>[Math.round(b.start), Math.round(b.end), ...(chosen(b)?[1]:[])])];
  const out=[];
  for (const w of all.sort((x,y)=>x[0]-y[0])){
    const last=out[out.length-1];
    if (last && Math.abs(w[0]-last[1])<1000 && last[2]===w[2]) last[1]=Math.max(last[1], w[1]);
    else out.push([...w]);
  }
  return out;
}
// Battery level now, from the level set at s.socAt, plus planned charging since then (assumes the plan was
// followed), minus the drives (legs, see drivesDone()) since then at the season's consumption. null if socAt
// is unknown. plan() starts from this; rollLevel() keeps socAt recent, so it never runs out.
function levelEst(s, now){
  const to=now.getTime(), from=s.socAt;
  if (!(from>0) || from>to) return null;
  const trips=drivesDone(s, from, to);
  const B=s.battery, kw=s.chargerKw*s.effPct/100;
  const kwhIn=w=>Math.max(0, Math.min(w[1],to)-Math.max(w[0],from))/H*kw;
  const chargedKwh=s.planned.reduce((a,w)=>a+kwhIn(w), 0), chosenKwh=s.planned.reduce((a,w)=>a+(w[2] ? kwhIn(w) : 0), 0);
  const usedKwh=trips.reduce((a,t)=>a+t.kwh,0), km=trips.reduce((a,t)=>a+t.km,0);
  const startKwh=B*s.soc/100+chargedKwh;
  const kwh=Math.min(B, Math.max(0, startKwh-usedKwh));
  return { from, fromPct:s.soc, B, chargedKwh, chosenKwh, trips, km, usedKwh, cons:km ? usedKwh/km*100 : null, startKwh, kwh, pct:Math.round(kwh/B*100) };
}
// The estimate to offer as a reading after a drive: null if no drive was made since the level was set.
function socEstimate(s, now){ const e=levelEst(s, now); return e && e.trips.length ? e : null; }
// The estimate since the last reading of the car, which a new reading is logged against (so a level moved forward
// in between doesn't split the interval). null without a drive since, or if that reading is over two weeks old.
function readingEst(s, now){
  if (!(s.readAt>0) || now.getTime()-s.readAt>14*DAY) return null;
  return socEstimate({...s, soc:s.readSoc, socAt:s.readAt}, now);
}
// Once the level is a day old, replace it with the estimate (unrounded, not a reading), so it never goes stale
// and the stored windows and km overrides it needs stay short. null if nothing to do.
function rollLevel(s, now){
  if (!(s.socAt>0) || now.getTime()-s.socAt<DAY) return null;
  const e=levelEst(s, now);
  return e ? { soc:Math.round(e.kwh/s.battery*1e4)/100, socAt:now.getTime() } : null;
}
const r2 = v => Math.round(v*100)/100;
// Log a reading after a drive (actualPct null = the estimate was accepted). A change within 10 minutes of the
// last reading with no drive ended since is a nudge of the slider: it corrects that reading instead of adding one.
function logReading(log, est, actualPct, s, now){
  const t=now.getTime(), last=log[log.length-1];
  const act=start=>actualPct==null ? null : r2(start-s.battery*actualPct/100);
  if (last && t-last.at<10*60e3 && !drivesDone(s, last.at, t).length)
    return [...log.slice(0,-1), {...last, at:t, actKwh:act(last.startKwh)}];
  if (!est) return log;
  const legs=est.trips.map(x=>x.leg), leg=legs.every(l=>l==="day") ? "day" : legs.length===1 ? legs[0] : "mixed";
  // date: the commute day a km correction applies to (an errand has no commute km to correct)
  const commute=est.trips.filter(x=>x.leg!=="errand"), date=commute.length ? commute[commute.length-1].key : null;
  const entry={ at:t, from:est.from, date, leg, km:r2(est.km), predKwh:r2(est.usedKwh),
    chargedKwh:r2(est.chargedKwh), chosenKwh:r2(est.chosenKwh), startKwh:r2(est.startKwh), actKwh:act(est.startKwh) };
  return [...log, entry].slice(-LOG_MAX);
}
// Whether a log entry can teach consumption: a reading, not explained by charging (cause, see explainReading()),
// and a plausible consumption (8–35 kWh/100 km), so a missed or unknown charge doesn't count as driving.
function usableReading(e){
  if (e.actKwh==null || e.cause==="charging" || !(e.km>0)) return false;
  const c=e.actKwh/e.km*100;
  return c>=8 && c<=35;
}
// After a km correction: recount the last reading's km and predicted energy (the overrides now apply).
function relogKm(log, s){
  const last=log[log.length-1]; if (!last) return log;
  const trips=drivesDone(s, last.from, last.at);
  return [...log.slice(0,-1), {...last, km:r2(trips.reduce((a,t)=>a+t.km,0)), predKwh:r2(trips.reduce((a,t)=>a+t.kwh,0))}];
}
// A reading far enough off the prediction to ask about the distance: 5+ points of battery and 25%+ off.
// Not for a single drive to or from work: on half a trip, rounding and morning/evening differences dominate.
function deviates(e, s){
  return e.leg!=="out" && e.leg!=="back" && e.actKwh!=null && e.predKwh>0 && Math.abs(e.actKwh-e.predKwh)>=0.05*s.battery && Math.abs(e.actKwh/e.predKwh-1)>0.25;
}

/* ---------- history ---------- */
// What the app assumes happened, written once it's in the past and not recalculated afterwards (so changing the
// weekly pattern doesn't rewrite past days). Entries, sorted by `at` (ms), kept HIST_DAYS:
//   drive   { at: back, dep, date, km, kwh, cons, src: schedule|override }  the day's round trip, once it has ended
//   charge  { at: start, end, kwh, chosen }  a charging window the app showed (assumed) or the user chose
//   drive   { …, dep: null, src: errand }   an errand (s.errands, setErrand()) at its time; one told with a
//           reading (addErrand()) sits just before the reading
//   reading { at, pct, estPct, diffKwh, chargedKwh, cause? }  a level set from the car, vs. the estimate then
//           (diff = car − estimate), with the charging assumed since the previous reading
//   level   { at, pct, how: use|roll }       the estimate taken as the level ("Use", or moved forward by rollLevel())
const histSort = (h, t) => h.filter(e=>e.at>=t-HIST_DAYS*DAY).sort((a,b)=>a.at-b.at);
function driveEntry(day, s){
  const {key, km, dep, back}=commuteOn(day, s);
  return { k:"drive", at:back, dep, date:key, km, kwh:r2(kwhFor(km, day, s)), cons:consFor(day, s),
    src: s.overrides[key]!=null ? "override" : "schedule" };
}
// Add the drives and charging windows that have ended since s.histAt (on the first run: since the oldest stored
// reading, level or window, max 14 days, plus the readings in socLog). Running it twice adds nothing.
function recordHistory(s, now){
  const t=now.getTime(), hist=s.history.map(h=>({...h}));   // copies: a charge entry may be extended below
  let from=s.histAt;
  if (!(from>0)){
    from=Math.max(t-14*DAY, Math.min(t, s.readAt||t, s.socAt||t, ...s.socLog.map(e=>e.from), ...s.planned.map(w=>w[0])));
    for (const e of s.socLog) if (e.actKwh!=null && e.at>=from)
      hist.push({ k:"reading", at:e.at, pct:r2((e.startKwh-e.actKwh)/s.battery*100), estPct:r2((e.startKwh-e.predKwh)/s.battery*100), diffKwh:r2(e.predKwh-e.actKwh) });
  }
  from=Math.max(from, t-HIST_DAYS*DAY);
  for (let day=startOfDay(new Date(from)); day.getTime()<=t; day=addDays(day,1)){
    const {key, km, back}=commuteOn(day, s);
    if (km<=0 || back<=from || back>t || hist.some(h=>h.k==="drive" && h.date===key && h.src!=="errand")) continue;
    hist.push(driveEntry(day, s));
  }
  for (const e of s.errands) if (e.at>from && e.at<=t && !hist.some(h=>h.src==="errand" && h.at===e.at)) hist.push(errandEntry(e, s));
  // The plan re-clips a running window on every recompute, so `planned` holds it in pieces: join touching ones
  const kw=s.chargerKw*s.effPct/100;
  for (const [a,b,c] of [...s.planned].sort((x,y)=>x[0]-y[0])){
    if (b>t || b<=from) continue;
    const ch=hist.filter(h=>h.k==="charge");
    if (ch.some(h=>h.at<=a && h.end>=b)) continue;
    const prev=ch.find(h=>Math.abs(h.end-a)<1000 && h.chosen===(c===1));
    if (prev){ prev.end=b; prev.kwh=r2((b-prev.at)/H*kw); }
    else hist.push({ k:"charge", at:a, end:b, kwh:r2((b-a)/H*kw), chosen:c===1 });
  }
  return { history:histSort(hist, t), histAt:t };
}
// A level set from the car, against the estimate before it (est from levelEst(), or null), with the charging
// assumed since the previous reading (chargedKwh). A change within 10 minutes of the last entry, if that is a
// reading, corrects it (like logReading()) and keeps its estimate and charging.
function addReading(history, est, pct, B, now, chargedKwh=0){
  const t=now.getTime(), last=history[history.length-1];
  if (last && last.k==="reading" && t-last.at<10*60e3)
    return [...history.slice(0,-1), {...last, at:t, pct, diffKwh:last.estPct==null ? null : r2(B*(pct-last.estPct)/100)}];
  return histSort([...history, { k:"reading", at:t, pct, estPct:est ? r2(est.kwh/B*100) : null, diffKwh:est ? r2(B*pct/100-est.kwh) : null,
    chargedKwh:r2(chargedKwh) }], t);
}
function addLevel(history, pct, how, now){
  return histSort([...history, { k:"level", at:now.getTime(), pct:r2(pct), how }], now.getTime());
}
// Ask about a reading (history entry from addReading()) far off the estimate: "low" (car below it) or "high",
// else null. Needs 5+ points; when the interval had a drive (logged, a socLog entry), also deviates().
function readingQuestion(reading, logged, s){
  if (!reading || reading.diffKwh==null || Math.abs(reading.diffKwh)<0.05*s.battery) return null;
  if (logged && !deviates(logged, s)) return null;
  return reading.diffKwh<0 ? "low" : "high";
}
const LOG_CAUSE = { drove:"km", "charging-short":"charging", "charged-elsewhere":"charging", ok:"ok" };
// The user's answer for the reading at `at`: drove (distance corrected), charging-short (planned charging didn't
// run fully), charged-elsewhere or ok (just off). Kept on the history reading and the socLog entry (if any).
function explainReading(history, log, at, cause){
  return { history:history.map(e=>e.k==="reading" && e.at===at ? {...e, cause} : e),
    socLog:log.map(e=>e.at===at ? {...e, cause:LOG_CAUSE[cause]} : e) };
}
function errandEntry(e, s){
  const day=new Date(e.at);
  return { k:"drive", at:e.at, dep:null, date:dateKey(day), km:e.km, kwh:r2(kwhFor(e.km, day, s)), cons:consFor(day, s), src:"errand" };
}
// Set the km of the errand at `at` (a drive outside the commute; 0 km removes it). A past one goes into the history
// now (recordHistory() adds a future one once it has happened). Errands older than the level and the last reading
// (max 14 days) are dropped: the estimate no longer needs them. Returns { errands, history, soc }.
// soc: the level, corrected when it was estimated ("Use", rollLevel()) after the errand without it; a reading
// after the errand already includes it.
function setErrand(s, at, km, now){
  const t=now.getTime(), keep=Math.max(Math.min(s.socAt||t, s.readAt||t), t-14*DAY);
  const old=s.errands.find(e=>e.at===at)?.km || 0;
  const errands=[...s.errands.filter(e=>e.at!==at && e.at>keep), ...(km>0 ? [{ at, km }] : [])].sort((a,b)=>a.at-b.at);
  const rest=s.history.filter(e=>!(e.k==="drive" && e.src==="errand" && e.at===at));
  const missed=s.socAt>0 && at<=s.socAt && !(s.readAt>=at);
  const soc=missed ? Math.min(100, Math.max(0, s.soc-kwhFor(km-old, new Date(at), s)/s.battery*100)) : s.soc;
  return { errands, history: km>0 && at<=t ? histSort([...rest, errandEntry({ at, km }, s)], t) : rest, soc };
}
// An errand told with a reading at `at` (it explains a low reading with no drive logged): just before the reading,
// so it sorts first and the level the reading set already includes it. Replaces an errand told within the 10
// minutes before (the reading may have been nudged since). 0 km removes it. Returns { errands, history, soc }.
function addErrand(s, km, at, now){
  const old=s.errands.filter(e=>e.at<at && e.at>at-10*60e3).concat(s.history.filter(e=>e.k==="drive" && e.src==="errand" && e.at<at && e.at>at-10*60e3));
  let r={ errands:s.errands, history:s.history, soc:s.soc };
  for (const e of old) r=setErrand({ ...s, ...r }, e.at, 0, now);
  return setErrand({ ...s, ...r }, at-1, km, now);
}
// After a km correction for a day: its drive entry (if recorded) takes the new distance.
function correctDrive(history, key, s){
  return history.map(e=>e.k==="drive" && e.date===key && e.src!=="errand" ? {...driveEntry(new Date(key+"T12:00"), s), at:e.at, dep:e.dep} : e);
}
// One row per entry, for checking in a spreadsheet.
function historyCsv(history){
  const ts=t=>`${dateKey(new Date(t))} ${hhmm(t)}`;
  const v=x=>{ const q=x==null ? "" : String(x); return /[",\n]/.test(q) ? `"${q.replace(/"/g,'""')}"` : q; };
  const rows=history.map(e=>e.k==="drive" ? [ts(e.dep||e.at), e.dep ? ts(e.at) : "", "drive", e.km, -e.kwh, "", "", `${e.cons} kWh/100 km, ${e.src}`]
    : e.k==="charge" ? [ts(e.at), ts(e.end), "charge", "", e.kwh, "", "", e.chosen ? "chosen" : "assumed"]
    : e.k==="reading" ? [ts(e.at), "", "reading", "", e.diffKwh, e.pct, e.estPct, e.cause||""]
    : [ts(e.at), "", "level", "", "", e.pct, "", e.how]);
  return [["start","end","type","km","kwh","pct","est_pct","note"], ...rows].map(r=>r.map(v).join(",")).join("\n");
}

/* ---------- decision card ---------- */
const fmtKr = v => v.toFixed(2).replace(".",",");
const pct = (kwh,B) => Math.round(kwh/B*100);

// Price check: for each of the last `days` full days, the average of its cheapest k hours while the car was
// home (whole day on WFH days and weekends, outside departure–return on driving days), at today's tariffs.
// Tells whether a window is actually cheap or just the least bad option ahead.
function recentDays(prices, s, now, k, days=7){
  const out=[], today=startOfDay(now);
  for (let i=1;i<=days;i++){
    const day=addDays(today,-i), next=addDays(day,1).getTime(), {km, dep, back}=commuteOn(day, s);
    const ps=[];
    for (let t=day.getTime(); t<next; t+=H){
      if (km>0 && t<back && t+H>dep) continue;   // away, same rule as plan()
      const sp=prices.get(t); if (sp!=null) ps.push(totalPrice(sp,t,s));
    }
    if (ps.length<k) continue;
    ps.sort((a,b)=>a-b); out.push(ps.slice(0,k).reduce((a,b)=>a+b,0)/k);
  }
  return out.sort((a,b)=>a-b);
}
// Price below which an hour counts as cheap for a top-up: it would rate "cheap" (beat at least 70% of recent
// days) against the cheapest home hours of each day, k = hours to charge from the reserve to the charge limit.
// null with under 3 days of history.
function cheapLimit(prices, s, now){
  const k=Math.max(1, Math.ceil(s.battery*(s.maxSoc-s.reserve)/100/(s.chargerKw*s.effPct/100)));
  const days=recentDays(prices, s, now, k), n=days.length;
  return n<3 ? null : days[n-Math.ceil(0.7*n-1e-9)];
}
// Rank price x against recent days: "cheap" if it beats at least 70% of them, "pricey" if at most 30%.
function priceRating(x, days){
  const n=days.length; if (n<3) return null;
  const beat=days.filter(v=>v>x).length, f=beat/n;
  return { level: f>=0.7 ? "cheap" : f<=0.3 ? "pricey" : "typical", beat, n, lo:days[0], hi:days[n-1] };
}

// Best single timer window covering the same battery energy as `sess` (several windows), for cars or wallboxes
// that take only one. Fills the span's home hours from the start or from the end, whichever is cheaper.
// Returns { start, end, extra } (extra kr vs. the planned windows) or null if the car is away in between.
function oneWindow(P, sess, s, now){
  const eff=s.effPct/100, kw=s.chargerKw*eff, nowMs=now.getTime();
  const a=sess[0].start, b=sess[sess.length-1].end;
  const span=P.slots.filter(sl=>sl.t+H>a && sl.t<b);
  if (!span.length || span.some(sl=>!sl.home)) return null;
  const E=sess.reduce((x,w)=>x+w.kwh*eff,0), planned=sess.reduce((x,w)=>x+w.cost,0);
  const fill=list=>{
    let left=E, cost=0; const used=[];
    for (const sl of list){ const v=Math.min(sl.capK,left); if (v>0){ used.push([sl,v]); cost+=v/eff*sl.price; left-=v; } }
    return left>0.01 ? null : { used, cost };
  };
  const opts=[];
  const f=fill(span);
  if (f){ const [sl,v]=f.used[f.used.length-1]; opts.push({ start:Math.max(span[0].t,nowMs), end:Math.max(sl.t,nowMs)+v/kw*H, cost:f.cost }); }
  const r=fill([...span].reverse());
  if (r){ const [sl,v]=r.used[r.used.length-1]; opts.push({ start:sl.t+H-v/kw*H, end:span[span.length-1].t+H, cost:r.cost }); }
  if (!opts.length) return null;
  const best=opts.reduce((x,y)=>y.cost<x.cost?y:x);
  return { start:best.start, end:best.end, extra:Math.max(0,best.cost-planned) };
}

// The car takes charge limits in 10% steps from 50%; round up so the limit never stops charging early.
const limitFor = (kwh, B) => Math.min(100, Math.max(50, Math.ceil(kwh/B*10-1e-6)*10));

// The session choice to store, holding until the car next leaves: the proposed windows ("plan"), one timer
// window of the user's ("manual": { start, end, limit } as clock times; a start up to 12 h ago means charging
// from now, an end at or before the start is the next day) or no charging ("none").
// null if a manual window doesn't fall between now and the departure.
function commitFrom(P, kind, now, manual){
  const nowMs=now.getTime(), leave=P.nextDrive ? P.nextDrive.t : null;
  const before=P.blocks.filter(b=>leave==null || b.start<leave);
  let windows=[], limit=null;
  if (kind==="plan"){
    windows=before.map(b=>[Math.round(b.start), Math.round(b.end)]);
    limit=limitFor(Math.max(...before.map(b=>b.lvlEnd)), P.B);
  }
  else if (kind==="manual"){
    let a=atTime(now, manual.start).getTime(); if (a<nowMs-12*H) a=atTime(addDays(now,1), manual.start).getTime();
    let e=atTime(new Date(a), manual.end).getTime(); if (e<=a) e=atTime(addDays(new Date(a),1), manual.end).getTime();
    a=Math.max(a, nowMs); if (leave!=null) e=Math.min(e, leave);
    if (e<=a) return null;
    windows=[[a,e]]; limit=manual.limit;
  }
  const until = leave ?? Math.max(nowMs, ...windows.map(w=>w[1]), ...before.map(b=>b.end));
  return { kind, until, windows, limit, at:nowMs };
}

// Decision card, pure so it can be tested. Two questions decide the level:
// is charging needed before the next drive (else it's just price-driven), and is the price known or forecast.
// "Now" means the time until the car next leaves, which can include midday on WFH days and weekends.
// cls: "bad" | "must" | "" (optional, known price) | "fc" (optional, forecast) | "ok" (nothing before you leave)
function decide(P, now, s, prices){
  const short=P.events.find(e=>e.short>0);
  const first=P.blocks[0];
  const nextDrive=P.nextDrive || P.events.find(e=>e.check);
  const day = t => { const l=dayLabel(t,now); return l==="Today"||l==="Tomorrow" ? l.toLowerCase() : l; };
  // "now", "tonight" (18:00–06:00 ahead), else "today 11:00", "tomorrow 11:00", "Sat 12:00"
  const when = t => {
    if (t<=now.getTime()+H) return "now";
    const h=new Date(t).getHours(), d=dayLabel(t,now);
    if ((d==="Today" && (h>=18 || h<6)) || (d==="Tomorrow" && h<6)) return "tonight";
    return `${day(t)} ${hm5(t)}`;
  };
  if (P.commit) return committed(P, now, s, short, nextDrive, day, when);
  if (short) return { cls:"bad", lvl:"Not enough",
    title:`Not enough time to charge for ${day(short.t)}`,
    big:`${short.need.toFixed(1)} kWh needed · ${short.short.toFixed(1)} kWh short`,
    sub:"Charge as soon as you can, or lower the reserve or trip length." };
  if (!first){
    const last=P.slots.length?P.slots[P.slots.length-1].t:now.getTime();
    return { cls:"ok", lvl:"Not needed", title:"No charging needed",
      big:`Battery ends around ${pct(P.endLvl,P.B)}% on ${DOW[new Date(last).getDay()]}`,
      sub:"Your commute is covered with your reserve intact for the days shown." };
  }
  // Charging you can do before the car next leaves; the card summarises the first session (windows within 18 h).
  const leaveAt=nextDrive ? nextDrive.t : Infinity;
  const before=P.blocks.filter(b=>b.start<leaveAt);
  const home=first.start<leaveAt;
  const sess=home ? before.filter(b=>b.start<first.start+18*H) : [first], lastW=sess[sess.length-1];
  const kwh=sess.reduce((a,b)=>a+b.kwh,0), cost=sess.reduce((a,b)=>a+b.cost,0), fc=sess.some(b=>b.fc);
  const label=`${dayLabel(first.start,now)} ${hm5(first.start)}–${hm5(lastW.end,true)}`;
  const avg=fmtKr(cost/kwh);
  const fcNote=" Hours are based on forecast prices; check again after 13:00.";
  const windows=(sess.length>1 ? ` Split into ${sess.length} windows, see the plan below.` : "")
    + (before.length>sess.length ? ` ${before.length-sess.length} more before you leave ${day(leaveAt)} ${hhmm(leaveAt)}.` : "");
  const must=(P.mustKwh||0)>0.05 && nextDrive;
  // Grid energy before the car leaves that is only a top-up (cheap price), not needed for a drive
  const fillGrid=P.slots.reduce((a,sl)=>a+(sl.fill && sl.t<leaveAt ? sl.fill : 0),0)/(s.effPct/100);
  // Compare this session's average with the same number of cheapest home hours on recent days.
  const k=Math.max(1, sess.reduce((a,b)=>a+(b.hours||Math.round((b.end-b.start)/H)),0));
  const r = home && prices ? priceRating(cost/kwh, recentDays(prices, s, now, k)) : null;
  const rate = r && { level:r.level, tag:{cheap:"Cheap", typical:"Typical", pricey:"Pricey"}[r.level],
    text:`${fc?"Expected ":""}${avg} kr/kWh beats ${r.beat} of the last ${r.n} days (cheapest ${k} home hour${k>1?"s":""} each: ${fmtKr(r.lo)}–${fmtKr(r.hi)} kr/kWh).` };
  const big=`${label} · ${kwh.toFixed(1)} kWh · ≈ ${Math.round(cost)} kr${fc?" (forecast)":""}`;
  // What to set on the car or wallbox: a charge limit (battery % at the end of the session) and timer windows.
  let setup=null;
  if (home && lastW.lvlEnd!=null){
    // The car takes limits in 10% steps from 50%; round up so the limit never stops charging early.
    // The timer then sets the amount and the limit is a safety stop.
    const planned=lastW.lvlEnd/P.B*100, limit=limitFor(lastW.lvlEnd, P.B);
    const timers=sess.map(b=>`${b.start<=now.getTime()+60e3?"now":hm5(b.start)}–${hm5(b.end,true)}`);
    let hint;
    if (sess.length>1){
      const one=oneWindow(P, sess, s, now);
      hint=`Set ${sess.length} timer windows; the limit alone would also charge in between.`
        + (one ? ` If only one window is possible, use ${one.start<=now.getTime()+60e3?"now":hm5(one.start)}–${hm5(one.end,true)} (≈ ${fmtKr(one.extra)} kr more).` : "");
    }
    else {
      const h=Math.ceil(lastW.end/H)*H, exact=limit-planned<1;
      // Prices are per hour: if the limit matches the plan, running on to the end of the hour costs the same
      hint = !exact ? `The timer sets the amount (to about ${Math.round(planned)}%); the ${limit}% limit is just a safety stop.`
        : h-lastW.end>60e3 ? `With the limit set, the timer can run until ${hhmm(h)}; prices are per hour, so it costs the same.`
        : "The limit stops charging at the right level; the timer keeps it in the cheap hours.";
    }
    setup={ limit, timers, hint };
  }
  if (must && home){
    const p=pct(P.noChargeLvl,P.B), needGrid=P.mustKwh/(s.effPct/100), planned=before.reduce((a,b)=>a+b.kwh,0);
    const without = p<=0 ? `Without charging you'd run out before getting home from ${day(nextDrive.t)}'s drive.`
      : `Without charging you'd get home from ${day(nextDrive.t)}'s drive with ${p}%, below your ${s.reserve}% reserve.`;
    // The rest is cheaper now than after leaving (later drives), a top-up while it's cheap, or both
    const topTo=`tops up to ${limitFor(lastW.lvlEnd,P.B)}% while the price is low`, allTop=fillGrid>planned-needGrid-1;
    const extra = planned-needGrid>1 ? ` At least ${needGrid.toFixed(1)} kWh is needed; the rest ${allTop ? topTo : "is cheaper before you leave than after"}.` : "";
    const top = fillGrid>1 && !allTop ? ` ${fillGrid.toFixed(1)} kWh of it ${topTo}.` : "";
    return { cls:"must", lvl:`Needed for ${day(nextDrive.t)}`, title:`Charge ${when(first.start)}`, big, rate, setup, choose:true,
      sub: without + extra + top + windows + (fc ? fcNote : ` Average ${avg} kr/kWh.`) };
  }
  if (home && !fc) return { cls:"", lvl: rate && rate.level==="cheap" ? "Optional · good price" : "Optional · cheapest ahead",
    title:`Charge ${when(first.start)}`, big, rate, setup, choose:true,
    sub: (fillGrid>before.reduce((a,b)=>a+b.kwh,0)/2 ? (nextDrive ? `Not needed for ${day(nextDrive.t)} yet, but the price is low, so it tops up.` : "The price is low, so it tops up.")
      : nextDrive ? `Not needed for ${day(nextDrive.t)} yet, but this is the cheapest time in the plan.` : "Below your always-fill price.")
      + ` Average ${avg} kr/kWh.` + windows };
  if (home) return { cls:"fc", lvl:"Forecast", title:`Probably charge ${when(first.start)}`, big, rate, setup, choose:true,
    sub:`Not needed yet, but this looks like the cheapest time. Expected ≈ ${avg} kr/kWh.` + windows + fcNote };
  return { cls:"ok", lvl:"Not needed yet",
    title:"No need to charge before you leave",
    big:`Next: ${label} · ${first.kwh.toFixed(1)} kWh${first.fc?" (forecast)":""}`,
    sub: (nextDrive ? `You get home from ${day(nextDrive.t)}'s drive with ${pct(nextDrive.lvlAfter,P.B)}%. ` : "")
      + (first.fc ? `Expected ≈ ${avg} kr/kWh. Check again after 13:00 when tomorrow's prices are published.` : `Known price ≈ ${avg} kr/kWh.`) };
}

// Card for a session the user chose (accepted plan, own timer or no charging); it holds until the car leaves.
function committed(P, now, s, short, nextDrive, day, when){
  const c=P.commit, lvl={ plan:"Accepted", manual:"Your timer", none:"Not charging" }[c.kind];
  const base={ committed:true, lvl, rate:null, setup:null };
  if (short) return { ...base, cls:"bad", title:`Your choice leaves ${day(short.t)} short`,
    big:`${short.short.toFixed(1)} kWh short of your ${s.reserve}% reserve`,
    sub:"Change the plan, or charge more before you leave." };
  const home = nextDrive ? `You get home from ${day(nextDrive.t)}'s drive with ${pct(nextDrive.lvlAfter,P.B)}%.` : "";
  const leave = nextDrive ? ` before you leave ${day(nextDrive.t)} ${hhmm(nextDrive.t)}` : "";
  if (c.kind==="none") return { ...base, cls:"ok", title:`No charging${leave}`,
    big: nextDrive ? `Leave with ${pct(nextDrive.lvlBefore,P.B)}%` : `Battery stays at ${pct(P.soc0,P.B)}%`, sub:home };
  const chosen=P.blocks.filter(b=>b.start<c.until);
  const timers=c.windows.filter(w=>w[1]>now.getTime()).map(([a,b])=>`${a<=now.getTime()+60e3?"now":hm5(a)}–${hm5(b,true)}`);
  const setup={ limit:c.limit, timers, hint:"" };
  if (!chosen.length) return { ...base, cls:"ok", setup, title:`No charging${leave}`,
    big: timers.length ? `The battery is already at the ${c.limit}% limit` : "The timer window has passed", sub:home };
  const first=chosen[0], last=chosen[chosen.length-1];
  const kwh=chosen.reduce((a,b)=>a+b.kwh,0), cost=chosen.reduce((a,b)=>a+b.cost,0), fc=chosen.some(b=>b.fc);
  return { ...base, cls:"", setup, title:`Charge ${when(first.start)}`,
    big:`${dayLabel(first.start,now)} ${hm5(first.start)}–${hm5(last.end,true)} · ${kwh.toFixed(1)} kWh · ≈ ${Math.round(cost)} kr${fc?" (forecast)":""} · to ${pct(last.lvlEnd,P.B)}%`,
    sub: home + (fc ? " Part of the price is a forecast." : "") };
}

export {
  H, DEF, STORE, LIMITS, clone, getPath, setPath, clampSetting, migrateTariffs, settingsFrom,
  pad, dateKey, DOW, shortDay, monIdx, atTime, startOfDay, addDays, hhmm, round5, hm5, dayLabel,
  SEASON, consFor, isTariffWinter, tariff, priceParts, totalPrice, wpow, features, fitModel, parsePrices, demoData, setErrand, oneWindow, recentDays, cheapLimit, priceRating, kmOn, patternKm, commuteOn, kwhFor,
  buildHours, drivesFor, plan, fmtKr, pct, decide, LOG_MAX, drivesDone, notePlanned, levelEst, socEstimate, readingEst, rollLevel, recordHistory, addReading, addLevel, correctDrive, historyCsv, HIST_DAYS, logReading, relogKm, deviates, usableReading, readingQuestion, explainReading, addErrand, limitFor, commitFrom
};
