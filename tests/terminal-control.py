import importlib.util
import pathlib
import subprocess
import tempfile
import time
import uuid

script = pathlib.Path(__file__).parents[1] / 'scripts' / 'terminal-control.py'
assert script.exists(), 'terminal-control.py is missing'
spec = importlib.util.spec_from_file_location('terminal_control', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
thread = 'test-' + uuid.uuid4().hex
with tempfile.TemporaryDirectory() as workspace:
    request = dict(backend='desktop', threadId=thread, workspace=workspace)
    session = module.desktop_create(thread, workspace)
    try:
        request['sessionId'] = session
        assert module.dispatch(dict(request, operation='list'))[0]['sessionId'] == session
        module.dispatch(dict(request, operation='write', text="printf 'RESULT=%s\\n' $((6*7))\n"))
        for _ in range(100):
            result = module.dispatch(dict(request, operation='read'))
            if 'RESULT=42' in result['output']: break
            time.sleep(.02)
        assert 'RESULT=42' in result['output']
        for bad in [dict(request, threadId='other'), dict(request, workspace='/'), dict(request, sessionId='wrong')]:
            try: module.dispatch(dict(bad, operation='write', text='echo bad\n'))
            except ValueError: pass
            else: raise AssertionError('Mismatched terminal accepted')
        module.dispatch(dict(request, operation='write', text='sleep 30\n'))
        time.sleep(.1)
        module.dispatch(dict(request, operation='interrupt'))
        module.dispatch(dict(request, operation='write', text="printf 'AFTER_INTERRUPT=%s\\n' yes\n"))
        for _ in range(100):
            result = module.dispatch(dict(request, operation='read'))
            if 'AFTER_INTERRUPT=yes' in result['output']: break
            time.sleep(.02)
        assert 'AFTER_INTERRUPT=yes' in result['output']
        print('Desktop input/output, isolation and Ctrl+C passed')
    finally:
        module.tmux('kill-session', '-t', session)
