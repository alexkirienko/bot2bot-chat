#!/usr/bin/env python3
"""Real-relay regression: same alias, distinct Python sessions and cursors."""
import argparse,base64,contextlib,json,os,pathlib,secrets,socket,subprocess,sys,tempfile,time
from unittest.mock import patch
import requests
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'sdk'))
from bot2bot import Room,_cli_load_or_create_identity,_cli_identity_path

def main():
 with tempfile.TemporaryDirectory(prefix='b2b-py-sessions-') as td:
  work=pathlib.Path(td); sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
  base=f'http://127.0.0.1:{port}'
  env=dict(os.environ,PORT=str(port),HOST='127.0.0.1',TAILSCALE_HOST='',CANONICAL_REDIRECT='0',TELEGRAM_BOT_TOKEN='',DISCORD_WEBHOOK_URL='')
  for k in ['METRICS_STATE_PATH','METRICS_HISTORY_PATH','METRICS_HOURLY_HISTORY_PATH','METRICS_GEO_MINUTE_HISTORY_PATH','METRICS_GEO_HOURLY_HISTORY_PATH','IDENTITIES_STATE_PATH','AGENT_DIRECTORY_STATE_PATH','BUGS_LOG']:env[k]=str(work/(k+'.json'))
  with open(work/'server.log','w') as log:
   p=subprocess.Popen(['node','server/index.js'],cwd=ROOT,env=env,stdout=log,stderr=log)
   try:
    for _ in range(60):
     try:
      if requests.get(base+'/api/health',timeout=1).status_code==200:break
     except requests.RequestException:pass
     time.sleep(.1)
    else:raise RuntimeError('relay not ready')
    with patch.dict(os.environ,{'HOME':td}):
     def args(session,path=None):return argparse.Namespace(identity_file=path,session=session,handle='same-agent')
     a_args,b_args=args('first'),args('second')
     a=_cli_load_or_create_identity(a_args,base);b=_cli_load_or_create_identity(b_args,base)
     assert a.handle != b.handle,'distinct sessions with same alias must register distinct handles'
     assert a.sign_pub_b64 != b.sign_pub_b64
     assert _cli_load_or_create_identity(a_args,base).to_bytes()==a.to_bytes(),'same session must reconnect stable identity'
     url=base+'/room/SESSIONS#k='+base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')
     room=Room(url,name='receiver');peer=Room(url,name='peer');peer.send('Both sessions must receive this')
     ca=room.claim(a,timeout=1);assert ca['message'].text=='Both sessions must receive this'
     room.ack_claim(a,ca['claim_id'],ca['message'].seq)
     cb=room.claim(b,timeout=1);assert cb['message'].text=='Both sessions must receive this','ACK by A must not advance B'
     room.ack_claim(b,cb['claim_id'],cb['message'].seq);room.close()
     legacy=args('ignored',str(work/'legacy.key'));one=_cli_load_or_create_identity(legacy,base)
     assert one.handle=='same-agent','explicit identity-file keeps original handle'
     colliding=args('ignored',str(work/'bad.key'))
     try:_cli_load_or_create_identity(colliding,base)
     except SystemExit as exc:assert exc.code==2
     else:raise AssertionError('409 for a different key must fail closed')
     assert not pathlib.Path(colliding.identity_file).exists(),'do not persist unregistered key after collision'
     assert _cli_load_or_create_identity(legacy,base).to_bytes()==one.to_bytes()
     print('PASS same-HOME Python sessions: unique handles, valid auth, independent ACK, stable reconnect, explicit legacy identity, fail-closed collision')
   finally:p.terminate();p.wait(timeout=10)
 return 0
if __name__=='__main__':raise SystemExit(main())
