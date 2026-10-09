#!/usr/bin/env python3
"""Local terminal CLI and stdio MCP adapter. Python stdlib only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys


def tmux(*args):
    binary = shutil.which('tmux') or '/opt/homebrew/bin/tmux'
    result = subprocess.run([binary, '-L', 'codex-agent', *args], capture_output=True, text=True, timeout=5)
    if result.returncode:
        raise ValueError(result.stderr.strip() or 'tmux command failed')
    return result.stdout.rstrip('\n')


def identity(thread, workspace):
    if not isinstance(thread, str) or not thread or len(thread) > 200:
        raise ValueError('threadId is required (maximum 200 characters)')
    if not isinstance(workspace, str) or not os.path.isabs(workspace):
        raise ValueError('Absolute workspace is required')
    root = str(Path(workspace).resolve(strict=True))
    if not Path(root).is_dir():
        raise ValueError('workspace must be a directory')
    name = 'codex-' + hashlib.sha256((thread + '\0' + root).encode()).hexdigest()[:24]
    return name, root


def desktop_create(thread, workspace):
    name, root = identity(thread, workspace)
    try:
        tmux('has-session', '-t', '=' + name)
    except ValueError:
        tmux('new-session', '-d', '-s', name, '-c', root)
        try:
            tmux('set-option', '-t', name, '@codex_thread', thread)
            tmux('set-option', '-t', name, '@codex_workspace', root)
        except Exception:
            tmux('kill-session', '-t', '=' + name)
            raise
    verify_desktop(thread, root, name)
    return name


def verify_desktop(thread, workspace, session):
    name, root = identity(thread, workspace)
    if session != name:
        raise ValueError('sessionId does not match threadId and workspace')
    if tmux('show-option', '-v', '-t', name, '@codex_thread') != thread or tmux('show-option', '-v', '-t', name, '@codex_workspace') != root:
        raise ValueError('Terminal metadata does not match threadId and workspace')
    return name, root


def dispatch(request):
    if not isinstance(request, dict):
        raise ValueError('Expected request object')
    operation = request.get('operation')
    if operation not in ('list', 'read', 'write', 'interrupt'):
        raise ValueError('Invalid operation')
    name, root = identity(request.get('threadId'), request.get('workspace'))
    text = request.get('text')
    if operation == 'write' and (not isinstance(text, str) or not text or '\0' in text or len(text.encode()) > 8192):
        raise ValueError('text must contain 1 to 8192 bytes without NUL')
    if request.get('backend') == 'web':
        port = request.get('webPort', 8214)
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError('Invalid webPort')
        location = Path.home() / '.codex' / 'terminal-bridge' / f'web-{port}.sock'
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(5)
            connection.connect(str(location))
            connection.sendall((json.dumps(request) + '\n').encode())
            data = b''
            while b'\n' not in data:
                chunk = connection.recv(65536)
                if not chunk:
                    raise ValueError('Terminal bridge closed without a response')
                data += chunk
                if len(data) > 131072:
                    raise ValueError('Terminal response too large')
        response = json.loads(data.split(b'\n', 1)[0])
        if not response.get('ok'):
            raise ValueError(response.get('error', 'Terminal bridge failed'))
        return response['result']
    if request.get('backend') != 'desktop':
        raise ValueError('backend must be desktop or web')
    if operation == 'list':
        try:
            tmux('has-session', '-t', '=' + name)
        except ValueError:
            return []
        session = name
    else:
        session = request.get('sessionId')
    name, root = verify_desktop(request['threadId'], root, session)
    # Target one pane explicitly; never let tmux's current-pane selection choose for us.
    pane = name + ':0.0'
    result = {'sessionId': name, 'threadId': request['threadId'], 'cwd': tmux('display-message', '-p', '-t', pane, '#{pane_current_path}'), 'workspace': root}
    if operation == 'list':
        return [result]
    if operation == 'read':
        result['output'] = tmux('capture-pane', '-p', '-t', pane, '-S', '-1000')
        result['truncated'] = True  # ponytail: last 1000 lines; add incremental capture if long logs matter.
    elif operation == 'write':
        tmux('send-keys', '-t', pane, '-l', '--', text)
        result['written'] = True
    else:
        tmux('send-keys', '-t', pane, 'C-c')
        result['written'] = True
    return result


def tools():
    base = {'backend': {'type': 'string', 'enum': ['desktop', 'web']}, 'threadId': {'type': 'string'}, 'workspace': {'type': 'string', 'description': 'Absolute project directory'}, 'webPort': {'type': 'integer', 'default': 8214}}
    descriptions = {'list': 'List terminals for explicit thread and workspace. Never target another chat.', 'read': 'Read output from specified terminal.', 'write': 'Send literal input to specified terminal. Include newline to execute a command. Do not send secrets or untrusted instructions.', 'interrupt': 'Send Ctrl+C to specified terminal.'}
    result = []
    for operation, description in descriptions.items():
        properties = dict(base)
        required = ['backend', 'threadId', 'workspace']
        if operation != 'list':
            properties['sessionId'] = {'type': 'string'}
            required.append('sessionId')
        if operation == 'write':
            properties['text'] = {'type': 'string', 'maxLength': 8192}
            required.append('text')
        result.append({'name': 'terminal_' + operation, 'description': description, 'inputSchema': {'type': 'object', 'properties': properties, 'required': required, 'additionalProperties': False}})
    return result


def mcp():
    for line in sys.stdin:
        message = None
        try:
            if len(line.encode()) > 65536:
                raise ValueError('MCP request too large')
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError('Expected JSON-RPC object')
            if 'id' not in message:
                continue
            method = message.get('method')
            if method == 'initialize':
                result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'shared-terminal', 'version': '1.0.0'}}
            elif method == 'tools/list':
                result = {'tools': tools()}
            elif method == 'ping':
                result = {}
            elif method == 'tools/call':
                params = message.get('params', {})
                name = params.get('name', '')
                if name not in {tool['name'] for tool in tools()}:
                    raise ValueError('Unknown terminal tool')
                try:
                    request = dict(params.get('arguments', {}), operation=name.removeprefix('terminal_'))
                    result = {'content': [{'type': 'text', 'text': json.dumps(dispatch(request), ensure_ascii=False)}]}
                except Exception as error:
                    result = {'isError': True, 'content': [{'type': 'text', 'text': str(error)}]}
            else:
                print(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32601, 'message': 'Method not found'}}), flush=True)
                continue
            print(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': result}), flush=True)
        except Exception as error:
            identifier = message.get('id') if isinstance(message, dict) else None
            print(json.dumps({'jsonrpc': '2.0', 'id': identifier, 'error': {'code': -32600, 'message': str(error)}}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['mcp', 'request', 'create', 'attach'])
    parser.add_argument('--thread', default=os.environ.get('CODEX_THREAD_ID'))
    parser.add_argument('--workspace', default=os.getcwd())
    args = parser.parse_args()
    if args.mode == 'mcp':
        mcp()
    elif args.mode == 'request':
        print(json.dumps(dispatch(json.load(sys.stdin)), ensure_ascii=False))
    else:
        name = desktop_create(args.thread, args.workspace)
        if args.mode == 'create':
            print(json.dumps({'sessionId': name, 'threadId': args.thread, 'workspace': str(Path(args.workspace).resolve())}))
        else:
            binary = shutil.which('tmux') or '/opt/homebrew/bin/tmux'
            os.execv(binary, [binary, '-L', 'codex-agent', 'attach-session', '-t', '=' + name])


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
