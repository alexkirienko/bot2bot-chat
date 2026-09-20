#!/usr/bin/env python3
"""A completed long claim grants the normal grace period to its consumer."""
import base64,os,pathlib,secrets,socket,subprocess,sys,tempfile,time
import requests
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'sdk'))
from bot2bot import Room,Identity

def main():
 with tempfile.TemporaryDirectory(prefix='b2b-claim-lifetime-') as td:
  work=pathlib.Path(td);s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close();base=f'http://127.0.0.1:{port}'
  env=dict(os.environ,PORT=str(port),HOST='127.0.0.1',TAILSCALE_HOST='',CANONICAL_REDIRECT='0',TELEGRAM_BOT_TOKEN='',DISCORD_WEBHOOK_URL='')
  for k in ['METRICS_STATE_PATH','METRICS_HISTORY_PATH','METRICS_HOURLY_HISTORY_PATH','METRICS_GEO_MINUTE_HISTORY_PATH','METRICS_GEO_HOURLY_HISTORY_PATH','IDENTITIES_STATE_PATH','AGENT_DIRECTORY_STATE_PATH','BUGS_LOG']:env[k]=str(work/(k+'.json'))
  with open(work/'relay.log','w') as log:
   p=subprocess.Popen(['node','server/index.js'],cwd=ROOT,env=env,stdout=log,stderr=log)
   try:
    for _ in range(60):
     try:
      if requests.get(base+'/api/health',timeout=1).status_code==200:break
     except requests.RequestException:pass
     time.sleep(.1)
    else:raise RuntimeError('relay not ready')
    url=base+'/room/LIFETIME#k='+base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')
    identity=Identity('lifetime-agent',base_url=base);identity.register()
    peer=Room(url,name='peer');recv=Room(url,name='receiver');peer.send('retained task')
    claim=recv.claim(identity,timeout=1);assert claim and claim['message'].text=='retained task';recv.ack_claim(identity,claim['claim_id'],claim['message'].seq)
    assert recv.claim(identity,timeout=32) is None
    time.sleep(14)
    payload=requests.get(base+'/api/rooms/LIFETIME/transcript',timeout=5).json()
    assert any(m['seq']==claim['message'].seq for m in payload.get('messages',[])), 'janitor evicted the room just after an active long claim completed'
    peer.send('late follow-up');late=recv.claim(identity,timeout=1);assert late and late['message'].text=='late follow-up'
    recv.ack_claim(identity,late['claim_id'],late['message'].seq)
    peer.close();recv.close();print('PASS room survives the response-to-next-claim thinking gap, then delivers late follow-up')
   finally:p.terminate();p.wait(timeout=10)
 return 0
if __name__=='__main__':raise SystemExit(main())
