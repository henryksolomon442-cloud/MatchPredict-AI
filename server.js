
const express=require("express");
const session=require("express-session");
const crypto=require("crypto");
const path=require("path");
require("dotenv").config();
const store=require("./store");

const app=express();
if(process.env.NODE_ENV==="production")app.set("trust proxy",1);

app.use(express.json({limit:"100kb"}));
app.use(express.urlencoded({extended:false,limit:"30kb"}));
app.use(session({
  name:"matchpredict.sid",
  secret:process.env.SESSION_SECRET||"local-dev-secret-change-before-public-deploy",
  resave:false,
  saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:30*24*60*60*1000}
}));
app.use(express.static(path.join(__dirname,"public")));

const AUTH_URL="https://auth.deriv.com/oauth2/auth";
const TOKEN_URL="https://auth.deriv.com/oauth2/token";
const DERIV_API_BASE="https://api.derivws.com";

const PLAN_AMOUNT=50;
const PLAN_CURRENCY="USD";
const PLAN_DAYS=30;
const TRIAL_ENFORCEMENT=String(process.env.TRIAL_ENFORCEMENT||"false").toLowerCase()==="true";
const PAYMENTS_ENABLED=String(process.env.PAYMENTS_ENABLED||"false").toLowerCase()==="true";
const OWNER_DERIV_ACCOUNT_ID=String(process.env.OWNER_DERIV_ACCOUNT_ID||"").trim();

function isOwnerUser(userKey){
  return Boolean(OWNER_DERIV_ACCOUNT_ID && String(userKey||"")===OWNER_DERIV_ACCOUNT_ID);
}

function baseUrl(req){
  return (process.env.APP_BASE_URL||`${req.protocol}://${req.get("host")}`).replace(/\/+$/,"");
}
function callbackUrl(req){return `${baseUrl(req)}/auth/deriv/callback`}
function makeRef(prefix){
  return (prefix+Date.now().toString(36)+crypto.randomBytes(6).toString("hex"))
    .replace(/[^a-zA-Z0-9]/g,"").slice(0,32);
}
function validEmail(v){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v||"").trim())}

async function derivAccounts(req){
  const auth=req.session?.deriv;
  if(!auth?.accessToken)return [];
  if(auth.expiresAt&&Date.now()>=auth.expiresAt){
    req.session.deriv=null;req.session.userKey=null;return [];
  }
  const r=await fetch(`${DERIV_API_BASE}/trading/v1/options/accounts`,{
    headers:{Authorization:`Bearer ${auth.accessToken}`}
  });
  if(!r.ok)return [];
  const d=await r.json();
  return Array.isArray(d?.data)?d.data:(d?.data?[d.data]:[]);
}

async function resolveUserKey(req){
  if(req.session?.userKey)return req.session.userKey;
  const accounts=await derivAccounts(req);
  const a=accounts[0]||null;
  const key=a?.account_id||a?.loginid||a?.id||null;
  if(key){
    req.session.userKey=String(key);
    await store.ensureUser(String(key));
    return String(key);
  }
  return null;
}

async function accessStatus(req){
  const userKey=await resolveUserKey(req);
  if(!userKey)return {
    authenticated:false,user_key:null,trial:null,owner_access:false,
    subscription_active:false,subscription_expires_at:null,
    enforcement_enabled:TRIAL_ENFORCEMENT,persistent_store:store.persistent()
  };
  const a=await store.getAccess(userKey);
  const owner=isOwnerUser(userKey);
  return {
    authenticated:true,
    user_key:userKey,
    owner_access:owner,
    trial:{
      started_at:a.trial_started_at.toISOString(),
      expires_at:a.trial_expires_at.toISOString(),
      remaining_ms:a.trial_remaining_ms,
      expired:a.trial_expired,
      duration_hours:48
    },
    subscription_active:owner||a.subscription_active,
    subscription_expires_at:owner?null:(a.subscription_expires_at?a.subscription_expires_at.toISOString():null),
    enforcement_enabled:TRIAL_ENFORCEMENT,
    persistent_store:store.persistent()
  };
}

async function analyzerAccess(req,res,next){
  if(!TRIAL_ENFORCEMENT)return next();
  try{
    const a=await accessStatus(req);
    if(!a.authenticated)return res.redirect("/?trial=login_required&next=/analyze");
    if(a.owner_access||a.subscription_active||!a.trial.expired)return next();
    return res.redirect("/pricing?trial=expired");
  }catch(e){
    console.error(e);
    res.status(503).send("Access service unavailable.");
  }
}

async function requirePaymentUser(req,res){
  if(!PAYMENTS_ENABLED){
    res.status(503).json({ok:false,error:"payments_not_enabled"});
    return null;
  }
  const key=await resolveUserKey(req);
  if(!key){
    res.status(401).json({ok:false,error:"login_required"});
    return null;
  }
  if(isOwnerUser(key)){
    res.status(409).json({ok:false,error:"owner_account_does_not_require_payment"});
    return null;
  }
  return key;
}

// ---------------- Status ----------------
app.get("/api/health",(req,res)=>res.json({
  ok:true,version:"25.2",mode:"online-subscriptions",
  plan:{amount:PLAN_AMOUNT,currency:PLAN_CURRENCY,days:PLAN_DAYS},
  payments_enabled:PAYMENTS_ENABLED,
  persistent_store:store.persistent()
}));

app.get("/api/auth/status",async(req,res)=>{
  const configured=Boolean(process.env.DERIV_OAUTH_CLIENT_ID&&process.env.APP_BASE_URL);
  const auth=req.session?.deriv;
  if(!auth?.accessToken)return res.json({authenticated:false,configured});
  try{
    const accounts=await derivAccounts(req);
    return res.json({authenticated:accounts.length>0,configured,accounts});
  }catch{
    return res.json({authenticated:true,configured,accounts:[]});
  }
});

app.get("/api/access/status",async(req,res)=>{
  try{res.json({ok:true,...await accessStatus(req)})}
  catch(e){res.status(500).json({ok:false,error:"access_status_failed"})}
});

app.get("/api/trial/status",async(req,res)=>{
  try{
    const a=await accessStatus(req);
    res.json({
      ok:true,trial:a.trial,subscription_active:a.subscription_active,
      subscription_expires_at:a.subscription_expires_at,
      enforcement_enabled:a.enforcement_enabled,authenticated:a.authenticated,
      persistent_store:a.persistent_store
    });
  }catch{res.status(500).json({ok:false,error:"trial_status_failed"})}
});

app.get("/api/payments/config",(req,res)=>res.json({
  ok:true,
  enabled:PAYMENTS_ENABLED,
  plan:{amount:PLAN_AMOUNT,currency:"USD",days:30},
  providers:{
    flutterwave:Boolean(process.env.FLW_SECRET_KEY),
    pesapal:Boolean(process.env.PESAPAL_CONSUMER_KEY&&process.env.PESAPAL_CONSUMER_SECRET&&process.env.PESAPAL_NOTIFICATION_ID),
    binance:Boolean(process.env.BINANCE_PAY_API_KEY&&process.env.BINANCE_PAY_SECRET_KEY)
  }
}));

// ---------------- Deriv OAuth ----------------
app.get("/auth/deriv/start",(req,res)=>{
  const clientId=process.env.DERIV_OAUTH_CLIENT_ID;
  if(!clientId)return res.status(503).send("Deriv login is not configured yet.");

  const verifier=crypto.randomBytes(48).toString("base64url");
  const challenge=crypto.createHash("sha256").update(verifier).digest("base64url");
  const state=crypto.randomBytes(24).toString("hex");
  req.session.oauth={verifier,state,createdAt:Date.now()};

  const u=new URL(AUTH_URL);
  u.searchParams.set("response_type","code");
  u.searchParams.set("client_id",clientId);
  u.searchParams.set("redirect_uri",callbackUrl(req));
  u.searchParams.set("scope",process.env.DERIV_OAUTH_SCOPE||"trade");
  u.searchParams.set("state",state);
  u.searchParams.set("code_challenge",challenge);
  u.searchParams.set("code_challenge_method","S256");
  res.redirect(u.toString());
});

app.get("/auth/deriv/callback",async(req,res)=>{
  try{
    const flow=req.session?.oauth;
    const code=String(req.query.code||"");
    const state=String(req.query.state||"");
    if(req.query.error)return res.status(400).send("Deriv login was cancelled or denied.");
    if(!flow||!code||state!==flow.state)return res.status(403).send("Deriv authentication state check failed.");

    const body=new URLSearchParams({
      grant_type:"authorization_code",
      client_id:process.env.DERIV_OAUTH_CLIENT_ID,
      code,
      code_verifier:flow.verifier,
      redirect_uri:callbackUrl(req)
    });
    const tr=await fetch(TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
    const token=await tr.json();
    req.session.oauth=null;
    if(!tr.ok||!token.access_token)return res.status(502).send("Deriv token exchange failed.");

    req.session.deriv={accessToken:token.access_token,expiresAt:Date.now()+Number(token.expires_in||3600)*1000};
    req.session.userKey=null;
    await resolveUserKey(req);
    res.redirect("/dashboard?login=success");
  }catch(e){
    console.error(e);
    res.status(500).send("Deriv authentication could not be completed.");
  }
});

app.post("/auth/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));

// ---------------- Flutterwave ----------------
app.post("/api/payments/flutterwave/create",async(req,res)=>{
  try{
    if(!process.env.FLW_SECRET_KEY)return res.status(503).json({ok:false,error:"flutterwave_not_configured"});
    const userKey=await requirePaymentUser(req,res);if(!userKey)return;
    const email=String(req.body?.email||"").trim();
    if(!validEmail(email))return res.status(400).json({ok:false,error:"valid_email_required"});

    const reference=makeRef("FLW");
    await store.createPayment({reference,userKey,provider:"flutterwave",amount:PLAN_AMOUNT,currency:"USD"});

    const r=await fetch("https://api.flutterwave.com/v3/payments",{
      method:"POST",
      headers:{Authorization:`Bearer ${process.env.FLW_SECRET_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({
        tx_ref:reference,amount:PLAN_AMOUNT,currency:"USD",
        redirect_url:`${baseUrl(req)}/payments/flutterwave/callback`,
        customer:{email},
        customizations:{title:"MatchPredict Pro",description:"30-day MatchPredict Pro access"},
        meta:{matchpredict_reference:reference}
      })
    });
    const d=await r.json();
    if(!r.ok||!d?.data?.link)return res.status(502).json({ok:false,error:d?.message||"checkout_failed"});
    res.json({ok:true,reference,checkout_url:d.data.link});
  }catch(e){console.error(e);res.status(500).json({ok:false,error:"flutterwave_create_failed"})}
});

app.get("/payments/flutterwave/callback",async(req,res)=>{
  try{
    const reference=String(req.query.tx_ref||"");
    const transactionId=String(req.query.transaction_id||"");
    if(!reference||!transactionId)return res.redirect("/pricing?payment=failed");

    const vr=await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`,{
      headers:{Authorization:`Bearer ${process.env.FLW_SECRET_KEY}`}
    });
    const d=await vr.json();
    const paid=d?.data?.status==="successful" &&
      Number(d?.data?.amount)>=PLAN_AMOUNT &&
      String(d?.data?.currency||"").toUpperCase()==="USD" &&
      String(d?.data?.tx_ref||"")===reference;

    if(!paid)return res.redirect("/pricing?payment=failed");
    await store.activateSubscription(reference,transactionId);
    res.redirect("/dashboard?payment=success");
  }catch(e){console.error(e);res.redirect("/pricing?payment=failed")}
});

// ---------------- Pesapal ----------------
async function pesapalToken(){
  const sandbox=String(process.env.PESAPAL_ENV||"live").toLowerCase()==="sandbox";
  const base=sandbox?"https://cybqa.pesapal.com/pesapalv3/api":"https://pay.pesapal.com/v3/api";
  const r=await fetch(`${base}/Auth/RequestToken`,{
    method:"POST",headers:{Accept:"application/json","Content-Type":"application/json"},
    body:JSON.stringify({
      consumer_key:process.env.PESAPAL_CONSUMER_KEY,
      consumer_secret:process.env.PESAPAL_CONSUMER_SECRET
    })
  });
  const d=await r.json();
  if(!r.ok||!d?.token)throw new Error("Pesapal authentication failed");
  return {base,token:d.token};
}

app.post("/api/payments/pesapal/create",async(req,res)=>{
  try{
    if(!(process.env.PESAPAL_CONSUMER_KEY&&process.env.PESAPAL_CONSUMER_SECRET&&process.env.PESAPAL_NOTIFICATION_ID)){
      return res.status(503).json({ok:false,error:"pesapal_not_configured"});
    }
    const userKey=await requirePaymentUser(req,res);if(!userKey)return;
    const email=String(req.body?.email||"").trim();
    if(!validEmail(email))return res.status(400).json({ok:false,error:"valid_email_required"});

    const reference=makeRef("PESA");
    await store.createPayment({reference,userKey,provider:"pesapal",amount:PLAN_AMOUNT,currency:"USD"});
    const {base,token}=await pesapalToken();

    const r=await fetch(`${base}/Transactions/SubmitOrderRequest`,{
      method:"POST",
      headers:{Authorization:`Bearer ${token}`,Accept:"application/json","Content-Type":"application/json"},
      body:JSON.stringify({
        id:reference,currency:"USD",amount:PLAN_AMOUNT,
        description:"MatchPredict Pro 30-day access",
        callback_url:`${baseUrl(req)}/payments/pesapal/callback`,
        cancellation_url:`${baseUrl(req)}/pricing?payment=cancelled`,
        notification_id:process.env.PESAPAL_NOTIFICATION_ID,
        billing_address:{email_address:email}
      })
    });
    const d=await r.json();
    if(!r.ok||!d?.redirect_url)return res.status(502).json({ok:false,error:d?.message||"checkout_failed"});
    await store.updatePaymentMeta(reference,{order_tracking_id:d.order_tracking_id||null});
    res.json({ok:true,reference,checkout_url:d.redirect_url});
  }catch(e){console.error(e);res.status(500).json({ok:false,error:"pesapal_create_failed"})}
});

app.get("/payments/pesapal/callback",async(req,res)=>{
  try{
    const trackingId=String(req.query.OrderTrackingId||req.query.orderTrackingId||"");
    const merchantRef=String(req.query.OrderMerchantReference||req.query.orderMerchantReference||"");
    if(!trackingId||!merchantRef)return res.redirect("/pricing?payment=failed");

    const {base,token}=await pesapalToken();
    const r=await fetch(`${base}/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(trackingId)}`,{
      headers:{Authorization:`Bearer ${token}`,Accept:"application/json"}
    });
    const d=await r.json();
    const completed=String(d?.payment_status_description||"").toUpperCase()==="COMPLETED" ||
      Number(d?.status_code)===1;
    if(!r.ok||!completed)return res.redirect("/pricing?payment=failed");

    await store.activateSubscription(merchantRef,trackingId);
    res.redirect("/dashboard?payment=success");
  }catch(e){console.error(e);res.redirect("/pricing?payment=failed")}
});

// ---------------- Binance Pay ----------------
function binanceHeaders(bodyText){
  const ts=Date.now().toString();
  const nonce=crypto.randomBytes(24).toString("base64url").replace(/[^a-zA-Z]/g,"").padEnd(32,"A").slice(0,32);
  const payload=`${ts}\n${nonce}\n${bodyText}\n`;
  const sig=crypto.createHmac("sha512",process.env.BINANCE_PAY_SECRET_KEY).update(payload).digest("hex").toUpperCase();
  return {
    "Content-Type":"application/json",
    "BinancePay-Timestamp":ts,
    "BinancePay-Nonce":nonce,
    "BinancePay-Certificate-SN":process.env.BINANCE_PAY_API_KEY,
    "BinancePay-Signature":sig
  };
}
async function binancePost(pathname,body){
  const txt=JSON.stringify(body);
  const r=await fetch(`https://bpay.binanceapi.com${pathname}`,{
    method:"POST",headers:binanceHeaders(txt),body:txt
  });
  const d=await r.json();
  if(!r.ok||d?.status!=="SUCCESS")throw new Error(d?.errorMessage||"Binance Pay request failed");
  return d?.data||{};
}

app.post("/api/payments/binance/create",async(req,res)=>{
  try{
    if(!(process.env.BINANCE_PAY_API_KEY&&process.env.BINANCE_PAY_SECRET_KEY)){
      return res.status(503).json({ok:false,error:"binance_not_configured"});
    }
    const userKey=await requirePaymentUser(req,res);if(!userKey)return;
    const reference=makeRef("BN");

    await store.createPayment({reference,userKey,provider:"binance",amount:PLAN_AMOUNT,currency:"USDT"});

    // Binance Pay has changed order APIs over time. This endpoint can be overridden in Render
    // without changing the app code.
    const createPath=process.env.BINANCE_PAY_CREATE_PATH||"/binancepay/openapi/v3/order";
    const d=await binancePost(createPath,{
      env:{terminalType:"WEB"},
      merchantTradeNo:reference,
      orderAmount:PLAN_AMOUNT,
      currency:"USDT",
      description:"MatchPredict Pro 30-day access",
      goodsDetails:[{
        goodsType:"02",
        goodsCategory:"Z000",
        referenceGoodsId:"MATCHPREDICT-PRO-30",
        goodsName:"MatchPredict Pro 30 days"
      }],
      returnUrl:`${baseUrl(req)}/pricing?provider=binance&ref=${reference}`,
      cancelUrl:`${baseUrl(req)}/pricing?payment=cancelled`
    });

    const url=d.checkoutUrl||d.qrcodeLink||d.deeplink||d.universalUrl||null;
    if(!url)return res.status(502).json({ok:false,error:"binance_checkout_url_missing"});
    await store.updatePaymentMeta(reference,{prepayId:d.prepayId||null});
    res.json({ok:true,reference,checkout_url:url});
  }catch(e){console.error(e);res.status(500).json({ok:false,error:e.message||"binance_create_failed"})}
});

app.get("/api/payments/binance/check",async(req,res)=>{
  try{
    const reference=String(req.query.ref||"");
    const p=await store.getPayment(reference);
    if(!p||p.provider!=="binance")return res.status(404).json({ok:false,error:"payment_not_found"});
    const d=await binancePost("/binancepay/openapi/order/query",{merchantTradeNo:reference,prepayId:null});
    if(String(d?.status||"").toUpperCase()==="PAID"){
      const result=await store.activateSubscription(reference,d.transactionId||d.prepayId||null);
      return res.json({ok:true,paid:true,subscription_expires_at:result.access.subscription_expires_at});
    }
    res.json({ok:true,paid:false,status:d?.status||"PENDING"});
  }catch(e){res.status(500).json({ok:false,error:"binance_check_failed"})}
});

// ---------------- Pages ----------------
app.get("/dashboard",(req,res)=>res.sendFile(path.join(__dirname,"public","dashboard.html")));
app.get("/analyze",analyzerAccess,(req,res)=>res.sendFile(path.join(__dirname,"public","analyze.html")));
app.get("/pricing",(req,res)=>res.sendFile(path.join(__dirname,"public","pricing.html")));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

const port=process.env.PORT||3000;
store.initStore()
  .then(()=>app.listen(port,()=>console.log(`MatchPredict AI V25.2 running on port ${port}`)))
  .catch(e=>{console.error("Startup failed:",e);process.exit(1)});
