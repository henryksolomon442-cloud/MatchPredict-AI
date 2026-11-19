(() => {
  const $ = id => document.getElementById(id);
  const state = { ws:null, req:0, pending:new Map(), connected:false, currency:"", loginid:"", busy:false, openContract:null, lastBuyAt:0, trades:0, wins:0, losses:0, pnl:0 };
  const log = msg => { const li=document.createElement("li"); li.textContent=new Date().toLocaleTimeString()+" — "+msg; $("log").prepend(li); };
  const status = (msg, kind="") => { $("tradeStatus").textContent=msg; $("tradeStatus").className="tradeStatus "+kind; };
  const pill = (online) => { $("connectionPill").className="pill"+(online?" online":""); $("connectionPill").innerHTML='<span class="dot"></span> '+(online?"DEMO CONNECTED":"NOT CONNECTED"); };
  const refresh = () => {
    $("connectBtn").disabled=state.connected;
    $("disconnectBtn").disabled=!state.connected;
    $("buyBtn").disabled=!(state.connected && $("confirmedCheck").checked && !state.busy && !state.openContract);
    $("tradeCount").textContent=state.trades; $("wins").textContent=state.wins; $("losses").textContent=state.losses;
    $("pnl").textContent=state.pnl.toFixed(2)+" "+(state.currency||"");
    $("currencyLabel").textContent=state.currency||"account currency";
  };
  function send(data) {
    return new Promise((resolve,reject) => {
      if(!state.ws || state.ws.readyState!==WebSocket.OPEN) return reject(new Error("Deriv connection is not open."));
      const req_id=++state.req; data.req_id=req_id;
      const timer=setTimeout(()=>{state.pending.delete(req_id);reject(new Error("Deriv request timed out. Please check the connection."));},12000);
      state.pending.set(req_id,{resolve,reject,timer});
      state.ws.send(JSON.stringify(data));
    });
  }
  function disconnect(message="Disconnected.") {
    if(state.ws){ try{state.ws.close();}catch{} }
    state.ws=null; state.connected=false; state.openContract=null; state.busy=false;
    for(const p of state.pending.values()){clearTimeout(p.timer);p.reject(new Error(message));}
    state.pending.clear(); pill(false); $("accountInfo").textContent=message; refresh();
  }
  function onMessage(event) {
    let msg; try{msg=JSON.parse(event.data);}catch{return;}
    if(msg.req_id && state.pending.has(msg.req_id)){
      const p=state.pending.get(msg.req_id); state.pending.delete(msg.req_id); clearTimeout(p.timer);
      if(msg.error) p.reject(new Error(msg.error.message||msg.error.code||"Deriv API error"));
      else p.resolve(msg);
    }
    if(msg.msg_type==="proposal_open_contract" && msg.proposal_open_contract){
      const c=msg.proposal_open_contract;
      if(c.is_sold || c.status==="won" || c.status==="lost"){
        const profit=Number(c.profit||0); state.pnl+=profit;
        if(profit>0) state.wins++; else state.losses++;
        state.openContract=null; state.busy=false;
        status((profit>0?"WIN":"LOSS")+" • "+profit.toFixed(2)+" "+state.currency+" • Contract "+c.contract_id,profit>0?"good":"bad");
        log("Contract settled: "+(profit>0?"WIN":"LOSS")+" "+profit.toFixed(2)+" "+state.currency);
        refresh();
      }
    }
    if(msg.error && !msg.req_id) log("Deriv: "+msg.error.message);
  }
  async function connect() {
    const appId=$("appId").value.trim(), token=$("token").value.trim();
    if(!/^\d+$/.test(appId) || !token){status("Enter your Deriv App ID and demo API token.","bad");return;}
    $("connectBtn").disabled=true; status("Connecting to Deriv…");
    try{
      const ws=new WebSocket("wss://ws.derivws.com/websockets/v3?app_id="+encodeURIComponent(appId));
      state.ws=ws;
      ws.onmessage=onMessage;
      ws.onerror=()=>log("WebSocket error. Check internet and App ID.");
      ws.onclose=()=>{ if(state.connected){state.connected=false;pill(false);status("Deriv connection closed. Reconnect to continue.","bad");refresh();} };
      await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error("Connection timed out.")),12000);ws.onopen=()=>{clearTimeout(t);resolve();};ws.addEventListener("error",()=>{clearTimeout(t);reject(new Error("Could not connect to Deriv."));},{once:true});});
      const auth=await send({authorize:token});
      const a=auth.authorize;
      if(!a || Number(a.is_virtual)!==1){disconnect("Real accounts are blocked. Please connect a DEMO token.");throw new Error("This bot is demo-only. The connected account is not a virtual/demo account.");}
      state.connected=true; state.currency=a.currency||"USD"; state.loginid=a.loginid||"Demo";
      $("token").value="";
      $("accountInfo").textContent="Connected: "+state.loginid+" • "+state.currency+" • Virtual demo";
      pill(true); status("Demo account connected. Confirm a digit to place a trade.","good"); log("Connected to demo account "+state.loginid); refresh();
    }catch(e){disconnect(e.message);status(e.message,"bad");log(e.message);}
    finally{refresh();}
  }
  async function buyMatch() {
    if(!state.connected || state.busy || state.openContract) return;
    if(!$("confirmedCheck").checked){status("Only place a trade after Matches Pro confirms the digit.","bad");return;}
    const now=Date.now(); if(now-state.lastBuyAt<10000){status("Please wait at least 10 seconds between trades.","bad");return;}
    const digit=$("digit").value, market=$("market").value;
    state.busy=true; refresh(); status("Requesting MATCH "+digit+" price for "+market+"…");
    try{
      const proposal=await send({proposal:1,amount:0.35,basis:"stake",contract_type:"DIGITMATCH",currency:state.currency,duration:1,duration_unit:"t",barrier:String(digit),underlying_symbol:market});
      if(!proposal.proposal || !proposal.proposal.id) throw new Error("Deriv did not return a valid price proposal.");
      const p=proposal.proposal;
      const bought=await send({buy:p.id,price:Number(p.ask_price)});
      const b=bought.buy;
      if(!b || !b.contract_id) throw new Error("Deriv did not confirm the purchase.");
      state.trades++; state.lastBuyAt=Date.now(); state.openContract=b.contract_id;
      status("TRADE PLACED • MATCH "+digit+" • "+market+" • Contract "+b.contract_id,"good");
      log("PLACED MATCH "+digit+" on "+market+" for "+Number(b.buy_price||0).toFixed(2)+" "+state.currency);
      refresh();
      await send({proposal_open_contract:1,contract_id:b.contract_id,subscribe:1});
    }catch(e){status("TRADE NOT PLACED • "+e.message,"bad");log("Trade rejected: "+e.message);state.openContract=null;}
    finally{state.busy=false;refresh();}
  }
  $("connectBtn").addEventListener("click",connect);
  $("disconnectBtn").addEventListener("click",()=>{disconnect();status("Disconnected.");log("Disconnected by user.");});
  $("buyBtn").addEventListener("click",buyMatch);
  $("confirmedCheck").addEventListener("change",refresh);
  window.addEventListener("beforeunload",()=>{if(state.ws)state.ws.close();});
  refresh();
})();