#!/usr/bin/env python3
"""Run a specified command with isolated relay stores, preserving real exit code."""
import os, pathlib, tempfile, subprocess, sys, json
root=pathlib.Path(__file__).resolve().parents[1]
work=pathlib.Path(tempfile.mkdtemp(prefix='b2b-tests-',dir=os.environ.get('TMPDIR',str(root))))
env=dict(os.environ,HOST='127.0.0.1',TAILSCALE_HOST='',CANONICAL_REDIRECT='0',TELEGRAM_BOT_TOKEN='',DISCORD_WEBHOOK_URL='')
for key in ['METRICS_STATE_PATH','METRICS_HISTORY_PATH','METRICS_HOURLY_HISTORY_PATH','METRICS_GEO_MINUTE_HISTORY_PATH','METRICS_GEO_HOURLY_HISTORY_PATH','IDENTITIES_STATE_PATH','AGENT_DIRECTORY_STATE_PATH','BUGS_LOG']:
 env[key]=str(work/(key+'.json'))
cmd=sys.argv[1:] or ['node','tests/run.js']
p=subprocess.run(cmd,cwd=root,env=env,text=True)
print(json.dumps({'command':cmd,'exit_code':p.returncode,'state_dir':str(work)}))
sys.exit(p.returncode)
