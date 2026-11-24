import hashlib
import json


def exam_digest(ir):
    # Keep model/judge overrides separate from exam identity.
    config = {k: ir[k] for k in ('program', 'data')}
    config['scoring'] = {k: v for k, v in ir['scoring'].items() if k != 'grader'}
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode())


def identity(ir, exam):
    digest = exam_digest(ir)
    with exam.open('rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''):
            digest.update(chunk)
    return digest.hexdigest()


def valid_score(row):
    value = row.get('score')
    return float(value) if row.get('status') == 'valid' and isinstance(value, (int, float)) else None


def mean(values):
    return round(sum(values) / len(values), 4) if values else None


def quality(result):
    return mean([s for row in result['results'] if (s := valid_score(row)) is not None])


def judge_key(result):
    grader = result.get('grader') or {}
    system = grader.get('system') or {}
    if not all((system.get('model'), system.get('provider'), grader.get('prompt_sha256'))):
        return None
    return json.dumps(grader, sort_keys=True)


def failure_path(folder, model):
    return folder / ".failed-runs" / hashlib.sha256(model.encode()).hexdigest()
