
let pool=null;
const memUsers=new Map();
const memPayments=new Map();

if(process.env.DATABASE_URL){
  try{
    const {Pool}=require("pg");
    pool=new Pool({
      connectionString:process.env.DATABASE_URL,
      ssl:process.env.NODE_ENV==="production"?{rejectUnauthorized:false}:false
    });
  }catch(e){
    console.error("Postgres unavailable:",e.message);
  }
}

async function initStore(){
  if(!pool)return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matchpredict_users(
      user_key TEXT PRIMARY KEY,
      trial_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      subscription_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matchpredict_payments(
      reference TEXT PRIMARY KEY,
      user_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      provider_id TEXT,
      provider_meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    )
  `);
}

function memUser(key){
  if(!memUsers.has(key)){
    memUsers.set(key,{
      user_key:key,
      trial_started_at:new Date(),
      subscription_expires_at:null
    });
  }
  return memUsers.get(key);
}

async function ensureUser(key){
  if(!key)throw new Error("user key required");
  if(!pool)return memUser(key);
  const r=await pool.query(`
    INSERT INTO matchpredict_users(user_key)
    VALUES($1)
    ON CONFLICT(user_key) DO UPDATE SET updated_at=NOW()
    RETURNING *
  `,[key]);
  return r.rows[0];
}

async function getAccess(key){
  const u=await ensureUser(key);
  const trialStarted=new Date(u.trial_started_at);
  const trialExpires=new Date(trialStarted.getTime()+48*60*60*1000);
  const sub=u.subscription_expires_at?new Date(u.subscription_expires_at):null;
  const now=new Date();
  return {
    trial_started_at:trialStarted,
    trial_expires_at:trialExpires,
    trial_remaining_ms:Math.max(0,trialExpires-now),
    trial_expired:now>=trialExpires,
    subscription_expires_at:sub,
    subscription_active:Boolean(sub&&sub>now)
  };
}

async function createPayment({reference,userKey,provider,amount,currency,meta={}}){
  if(!pool){
    const p={reference,user_key:userKey,provider,amount,currency,status:"pending",provider_id:null,provider_meta:meta,created_at:new Date(),paid_at:null};
    memPayments.set(reference,p);
    return p;
  }
  const r=await pool.query(`
    INSERT INTO matchpredict_payments(reference,user_key,provider,amount,currency,provider_meta)
    VALUES($1,$2,$3,$4,$5,$6)
    RETURNING *
  `,[reference,userKey,provider,amount,currency,JSON.stringify(meta)]);
  return r.rows[0];
}

async function getPayment(reference){
  if(!pool)return memPayments.get(reference)||null;
  const r=await pool.query(`SELECT * FROM matchpredict_payments WHERE reference=$1`,[reference]);
  return r.rows[0]||null;
}

async function updatePaymentMeta(reference,meta){
  const p=await getPayment(reference);
  if(!p)return null;
  const merged={...(p.provider_meta||{}),...(meta||{})};
  if(!pool){
    p.provider_meta=merged;
    return p;
  }
  const r=await pool.query(
    `UPDATE matchpredict_payments SET provider_meta=$2 WHERE reference=$1 RETURNING *`,
    [reference,JSON.stringify(merged)]
  );
  return r.rows[0];
}

async function activateSubscription(reference,providerId){
  const payment=await getPayment(reference);
  if(!payment)throw new Error("payment not found");
  if(payment.status==="paid")return {payment,access:await getAccess(payment.user_key),alreadyPaid:true};

  if(!pool){
    payment.status="paid";
    payment.provider_id=providerId||null;
    payment.paid_at=new Date();
    const u=memUser(payment.user_key);
    const now=Date.now();
    const existing=u.subscription_expires_at?new Date(u.subscription_expires_at).getTime():0;
    u.subscription_expires_at=new Date(Math.max(now,existing)+30*24*60*60*1000);
    return {payment,access:await getAccess(payment.user_key),alreadyPaid:false};
  }

  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const pr=await client.query(`SELECT * FROM matchpredict_payments WHERE reference=$1 FOR UPDATE`,[reference]);
    const p=pr.rows[0];
    if(!p)throw new Error("payment not found");

    if(p.status!=="paid"){
      await client.query(`
        UPDATE matchpredict_payments
        SET status='paid',provider_id=$2,paid_at=NOW()
        WHERE reference=$1
      `,[reference,providerId||null]);

      await client.query(`
        INSERT INTO matchpredict_users(user_key,subscription_expires_at)
        VALUES($1,NOW()+INTERVAL '30 days')
        ON CONFLICT(user_key) DO UPDATE SET
          subscription_expires_at=
            GREATEST(COALESCE(matchpredict_users.subscription_expires_at,NOW()),NOW())
            + INTERVAL '30 days',
          updated_at=NOW()
      `,[p.user_key]);
    }

    await client.query("COMMIT");
    return {payment:await getPayment(reference),access:await getAccess(p.user_key),alreadyPaid:p.status==="paid"};
  }catch(e){
    await client.query("ROLLBACK");
    throw e;
  }finally{
    client.release();
  }
}

module.exports={
  initStore,ensureUser,getAccess,createPayment,getPayment,updatePaymentMeta,activateSubscription,
  persistent:()=>Boolean(pool)
};
