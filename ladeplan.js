// Ladeplan: pure planning logic (no DOM, no storage, no network), shared by index.html and the tests.
// All times are device-local, which is assumed to be Danish time.
/* ---------- settings ---------- */
const H = 3600e3;
const DEF = {
  soc: 50, kmOneWay: 39, depart: "07:30", home: "17:00",
  pattern: [1,1,1,1,0,0,0],           // Mon..Sun, 1 = commute
  battery: 58, reserve: 10, maxSoc: 80, chargerKw: 11, effPct: 90, cheapFill: 0,
  oneWindowKr: 5,                      // accept up to this many kr extra to charge in one timer window
  cons: { s: 14, h: 17, w: 20 },        // kWh/100 km: summer, shoulder, winter
  seasons: "wwwhhssshhww",             // Jan..Dec
  area: "DK1",
  // Grid tariff: N1 C-customer rates from 1 Jan 2026 (n1.dk), converted from øre incl. VAT to kr excl. VAT
  t: { winter: { night: 0.08784, day: 0.2636, peak: 0.79072 },   // Oct–Mar: 10.98 / 32.95 / 98.84 øre incl. VAT
       summer: { night: 0.08784, day: 0.13176, peak: 0.34264 },  // Apr–Sep: 10.98 / 16.47 / 42.83 øre incl. VAT
       energinet: 0.14, elafgift: 0.008, supplier: 0.05 },
  overrides: {}                        // "YYYY-MM-DD" -> round-trip km
};
const STORE = "ladeplan.v1";
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

// Round-trip km on a date: per-date override, else the weekly pattern (0 = car home all day)
function kmOn(day, s){ const key=dateKey(day); return s.overrides[key]!=null ? s.overrides[key] : (s.pattern[monIdx(day)] ? 2*s.kmOneWay : 0); }

function drivesFor(s, now, horizonEnd){
  const ev=[];
  const need = (km, day) => km*consFor(day, s)/100;
  for (let i=0;i<4;i++){
    const day=addDays(startOfDay(now),i), key=dateKey(day);
    const km=kmOn(day, s);
    if (km<=0) continue;
    const dep=atTime(day,s.depart).getTime(), back=atTime(day,s.home).getTime();
    if (dep>=horizonEnd) continue;
    if (dep>now.getTime()) ev.push({t:dep, back, km, need:need(km,day), key, check:true});
    else if (back>now.getTime()) ev.push({t:back, back, km:km/2, need:need(km,day)/2, key, check:false, returning:true});
  }
  return ev;
}

function plan(hours, s, now){
  const nowMs=now.getTime(), B=s.battery, eff=s.effPct/100;
  const res=B*s.reserve/100, soc0=B*s.soc/100;
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
      const cand=order(slots.map((_,i)=>i).filter(i=>slots[i].home && slots[i].t+H<=ev.t));
      for (const i of cand){
        if (def<=0.01) break;
        const amt=Math.min(slots[i].capK-slots[i].charge, def, headroom(i,cap));
        if (amt>0.01){ slots[i].charge+=amt; def-=amt; }
      }
      ev.short = def>0.05 ? def : 0;
    }
  });
  if (s.cheapFill>0){
    for (const i of order(slots.map((_,i)=>i).filter(i=>slots[i].home && slots[i].price<=s.cheapFill))){
      const amt=Math.min(slots[i].capK-slots[i].charge, headroom(i,B*s.maxSoc/100));
      if (amt>0.01) slots[i].charge+=amt;
    }
  }
  // Prices are fixed per hour, so only the energy in each hour matters. In each run of consecutive charging
  // hours, move charge so at most one hour is partly used and it sits at one end of the run (whichever is
  // cheaper, and only if that doesn't cost more). The run then maps to one unbroken timer window.
  for (const sl of slots) if (sl.charge<=0.01) sl.charge=0;
  const runs=[]; let run=null;
  slots.forEach((sl,i)=>{ if (sl.charge>0){ if (run && run[run.length-1]===i-1) run.push(i); else runs.push(run=[i]); } else run=null; });
  for (const r of runs){
    if (r.length<2) continue;
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
      const [x,y] = dur>=b-a-1000 ? [a,b] : (!prev && next) ? [b-dur,b] : [a,a+dur];
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
      if (span.some(i=>!slots[i].home)) continue;
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
  return { slots, events, blocks, endLvl, B, nextDrive, mustKwh, noChargeLvl, res };
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
    const day=addDays(today,-i), next=addDays(day,1).getTime(), km=kmOn(day,s);
    const dep=atTime(day,s.depart).getTime(), back=atTime(day,s.home).getTime();
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
    const planned=lastW.lvlEnd/P.B*100, limit=Math.min(100, Math.max(50, Math.ceil(planned/10-1e-6)*10));
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
    const extra = planned-needGrid>1 ? ` At least ${needGrid.toFixed(1)} kWh is needed; the rest is cheaper before you leave than after.` : "";
    return { cls:"must", lvl:`Needed for ${day(nextDrive.t)}`, title:`Charge ${when(first.start)}`, big, rate, setup,
      sub: without + extra + windows + (fc ? fcNote : ` Average ${avg} kr/kWh.`) };
  }
  if (home && !fc) return { cls:"", lvl: rate && rate.level==="cheap" ? "Optional · good price" : "Optional · cheapest ahead",
    title:`Charge ${when(first.start)}`, big, rate, setup,
    sub: (nextDrive ? `Not needed for ${day(nextDrive.t)} yet, but this is the cheapest time in the plan.` : "Below your always-fill price.")
      + ` Average ${avg} kr/kWh.` + windows };
  if (home) return { cls:"fc", lvl:"Forecast", title:`Probably charge ${when(first.start)}`, big, rate, setup,
    sub:`Not needed yet, but this looks like the cheapest time. Expected ≈ ${avg} kr/kWh.` + windows + fcNote };
  return { cls:"ok", lvl:"Not needed yet",
    title:"No need to charge before you leave",
    big:`Next: ${label} · ${first.kwh.toFixed(1)} kWh${first.fc?" (forecast)":""}`,
    sub: (nextDrive ? `You get home from ${day(nextDrive.t)}'s drive with ${pct(nextDrive.lvlAfter,P.B)}%. ` : "")
      + (first.fc ? `Expected ≈ ${avg} kr/kWh. Check again after 13:00 when tomorrow's prices are published.` : `Known price ≈ ${avg} kr/kWh.`) };
}

export {
  H, DEF, STORE, LIMITS, clone, getPath, setPath, clampSetting, migrateTariffs, settingsFrom,
  pad, dateKey, DOW, shortDay, monIdx, atTime, startOfDay, addDays, hhmm, round5, hm5, dayLabel,
  SEASON, consFor, isTariffWinter, tariff, priceParts, totalPrice, wpow, features, fitModel, parsePrices, demoData, oneWindow, recentDays, priceRating, kmOn,
  buildHours, drivesFor, plan, fmtKr, pct, decide
};
