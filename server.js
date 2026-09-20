const express=require("express");
const session=require("express-session");
const crypto=require("crypto");
const path=require("path");
require("dotenv").config();

const app=express();
if(process.env.NODE_ENV==="production") app.set("trust proxy",1);

app.use(express.json({limit:"20kb"}));
app.use(session({
  name:"matchpredict.sid",
  secret:process.env.SESSION_SECRET || "local-dev-secret-change-before-public-deploy",
  resave:false,
  saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:60*60*1000}
}));
app.use(express.static(path.join(__dirname,"public")));

const AUTH_URL="https://auth.deriv.com/oauth2/auth";
const TOKEN_URL="https://auth.deriv.com/oauth2/token";
const API_BASE="https://api.derivws.com";

function baseUrl(req){
  return (process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/,"");
}
function callbackUrl(req){return `${baseUrl(req)}/auth/deriv/callback`}

app.get("/api/health",(req,res)=>res.json({
  ok:true,version:"23.7",mode:"full-market-best-scanner-public-oauth-ready-paper-only"
}));

app.get("/api/auth/status",async(req,res)=>{
  const configured=Boolean(process.env.DERIV_OAUTH_CLIENT_ID && process.env.APP_BASE_URL);
  const auth=req.session?.deriv;
  if(!auth?.accessToken) return res.json({authenticated:false,configured});
  if(auth.expiresAt && Date.now()>=auth.expiresAt){
    req.session.deriv=null;
    return res.json({authenticated:false,configured,expired:true});
  }
  try{
    const r=await fetch(`${API_BASE}/trading/v1/options/accounts`,{
      headers:{Authorization:`Bearer ${auth.accessToken}`}
    });
    const data=await r.json();
    const accounts=Array.isArray(data?.data)?data.data:(data?.data?[data.data]:[]);
    return res.json({authenticated:true,configured,accounts});
  }catch{
    return res.json({authenticated:true,configured,accounts:[]});
  }
});

app.get("/auth/deriv/start",(req,res)=>{
  const clientId=process.env.DERIV_OAUTH_CLIENT_ID;
  if(!clientId){
    return res.status(503).send(`
      <body style="font-family:system-ui;background:#080a0e;color:white;padding:40px">
      <h2>Deriv login is not configured yet</h2>
      <p>The public scanner works now. OAuth login will work after you deploy the app and add a Deriv OAuth client ID and exact HTTPS callback URL.</p>
      <p><a href="/" style="color:#ffb000">Return to MatchPredict AI</a></p>
      </body>`);
  }

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
    if(req.query.error) return res.status(400).send("Deriv login was cancelled or denied.");
    if(!flow||!code||!state||state!==flow.state) return res.status(403).send("Deriv authentication state check failed.");
    if(Date.now()-flow.createdAt>10*60*1000){req.session.oauth=null;return res.status(400).send("Deriv login request expired.");}

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
    if(!tr.ok||!token.access_token) return res.status(502).send("Deriv token exchange failed. Check the registered callback URL and client ID.");
    req.session.deriv={accessToken:token.access_token,expiresAt:Date.now()+Number(token.expires_in||3600)*1000};
    res.redirect("/?login=success#dashboard");
  }catch(e){
    console.error(e);
    res.status(500).send("Deriv authentication could not be completed.");
  }
});

app.post("/auth/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

const port=process.env.PORT||3000;
app.listen(port,()=>console.log(`MatchPredict AI V23 running on port ${port}`));
