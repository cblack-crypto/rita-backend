import os, time, hmac, hashlib, json, uuid, random
import numpy as np
import requests
from dotenv import load_dotenv

load_dotenv()
URL = os.getenv('RITA_URL','http://localhost:3000')
SECRET = os.getenv('DEVICE_HMAC_SECRET','changeme')
SITE_ID = os.getenv('SITE_ID','siteA')
MODEL = os.getenv('MODEL_NAME','test-model')

def sign(raw: str, secret: str) -> str:
  return hmac.new(secret.encode(), raw.encode(), hashlib.sha256).hexdigest()

def gen_weights():
  # minimal single-layer toy
  w = np.random.randn(16).astype(float).tolist()
  return {"layer0": w}

def main():
  for i in range(3):
    body = {
      "siteId": SITE_ID,
      "modelName": MODEL,
      "weights": gen_weights(),
      "dataSampleCount": random.randint(100,500),
      "dataQuality": round(random.uniform(0.8,1.0),2),
      "timestamp": int(time.time()*1000),
      "nonce": str(uuid.uuid4())
    }
    raw = json.dumps(body, separators=(',',':'))
    sig = sign(raw, SECRET)
    r = requests.post(f"{URL}/api/v1/fl/weights",
                      data=raw,
                      headers={
                        "content-type":"application/json",
                        "x-signature": sig,
                        "x-dev-user": "dev-simulator"
                      })
    print(i, r.status_code, r.text[:200])
    time.sleep(1)

if __name__ == "__main__":
  main()
