import asyncio
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import benchy_proxy as p
import benchy_evaluation as e
from benchy_shared import workspace_override

YAML = """version: '1.0'
ontology_version: '1.1'
benchmark: {task: answer, domain: anthropology, language: es}
program:
  input: {question: string}
  output: {answer: string}
scoring:
  weights: {answer: 1}
  aggregator: weighted_mean
  field_metrics:
    answer:
      metric: rubric
      params:
        criteria:
          c1:
            weight: 1
            description: Coincide con la respuesta esperada.
            levels: {0: No coincide, 1: Coincide}
  grader: {type: model, provider: bedrock, model: judge-declared}
data: {path: ./exam.jsonl}
ai-system: {type: model, provider: bedrock, model: global.fixture-a}
"""

async def fake_report(bench, org=None):
    pass

def system(ir, workspace):
    model=ir['ai-system']['model']
    def invoke(data):
        q=data['question']
        if model.endswith('outage') or (model.endswith('mixed') and q=='3'):
            raise TimeoutError('fixture provider timeout')
        if q=='2' and model.endswith('mixed'):
            return {'answer': 12}
        if q=='1' and model.endswith('mixed'):
            return {'answer': 'wrong'}
        return {'answer': 'correct'}
    return invoke

def grader(ir, workspace):
    name=ir['scoring']['grader']['model']
    def invoke(data):
        if name=='judge-broken':
            raise TimeoutError('fixture judge timeout')
        success=data['answer']=='correct' and name!='judge-harsh'
        return {'c1': {'grade': int(success), 'justification': 'fixture'}}
    invoke.system={'provider':'bedrock','model':name}
    invoke.prompt_sha256='fixture-'+name
    return invoke

async def accept(ir): pass
async def main():
    e.check_models = accept
    e.benchy_adapters.for_system = system
    e.benchy_adapters.for_grader = grader
    p._write_report = fake_report
    with TemporaryDirectory(prefix='cases-') as d:
        root=Path(d)
        folder=root/'fixture'; folder.mkdir(); path='fixture/benchmark.yaml'
        (root/path).write_text(YAML)
        rows=[{'input':{'question':str(q)}, 'expected':{'answer':'correct'}} for q in range(4)]
        exam=folder/'exam.jsonl'
        def write_rows(rows): exam.write_text(''.join(json.dumps(r)+'\n' for r in rows))
        write_rows(rows)
        @web.middleware
        async def scope(req, handler):
            with workspace_override(root):
                return await handler(req)

        app=web.Application(middlewares=[scope])
        app.router.add_route('*','/benchy/evaluation',p.evaluation)
        app.router.add_get('/benchy/analysis',p.analysis)
        async with TestClient(TestServer(app),headers={'Authorization':'Bearer sandbox-fixture'}) as client:
            async def get(route):
                res=await client.get('/benchy/'+route,params={'path':path}); assert res.status==200
                payload=await res.json(); assert payload['ok'],payload
                return payload
            async def evaluate(models, judge):
                res=await client.post('/benchy/evaluation',json={'path':path,'models':models,'grader_model':judge})
                assert res.status==200,await res.text()
                payload=await res.json(); assert payload['ok'],payload
                for _ in range(100):
                    status=(await get('evaluation'))['evaluation']
                    if status['state'] not in ('running','reporting'): return status
                    await asyncio.sleep(.02)
                raise AssertionError('fixture did not finish')
            state=await evaluate(['global.fixture-good','global.fixture-mixed','global.fixture-outage'],'judge-actual')
            good,mixed,outage=state['models']; response=await get('analysis')
            by_model={r['model']:r for r in response['models']}
            runs={r['model']:json.loads((root/r['file']).read_text()) for r in state['models']}
            assert good['score']==1 and good['summary']==dict(examples=4,valid=4,invalid_outputs=0,execution_errors=0)
            assert mixed['score']==.5 and mixed['operational_score']==.25 and mixed['summary']==dict(examples=4,valid=2,invalid_outputs=1,execution_errors=1)
            assert outage['state']=='error' and outage['score'] is None and outage['operational_score']==0 and outage['summary']['execution_errors']==4
            assert [r['status'] for r in runs[mixed['model']]['results']]==['valid','valid','invalid_output','execution_error']
            assert by_model[mixed['model']]['score']==.5 and by_model[mixed['model']]['criteria']=={'c1':.5}
            assert by_model[mixed['model']]['groups']=={'Preguntas':.5}
            assert by_model[outage['model']]['score'] is None
            assert response['grader']=='judge-actual' and response['ranking']==[good['model']]
            assert response['questions'][3]['models'][mixed['model']]['score'] is None
            assert runs[good['model']]['grader']['system']['model']=='judge-actual'
            assert runs[mixed['model']]['benchmark_score']==.25
            print('COVERAGE: mixed .5 on 2/4 valid; operational .25; outage has no quality score')
            state=await evaluate(['global.fixture-other'],'judge-harsh')
            assert state['models'][0]['score']==0
            response=await get('analysis')
            assert response['grader'] is None and response['ranking']==[]
            assert response['hardest']==[] and response['regions']=={}
            assert response['comparison_blocked']=='different_judges'
            print('JUDGES: actual IDs retained; mixed-judge ranking and aggregates blocked')
            failed=await evaluate([good['model']],'judge-broken')
            assert failed['state']=='error' and failed['models'][0]['error']['code']=='grader_error'
            old=await get('analysis')
            assert next(m for m in old['models'] if m['model']==good['model'])['latest_error']['code']=='grader_error'
            assert good['model'] not in old['ranking']
            await evaluate(['global.fixture-other'], 'judge-actual')
            later = await get('analysis')
            assert next(m for m in later['models'] if m['model'] == good['model'])['latest_error']['code'] == 'grader_error'
            assert good['model'] not in later['ranking']
            await evaluate([good['model']], 'judge-actual')
            recovered = await get('analysis')
            assert good['model'] in recovered['ranking'] and len(recovered['ranking']) == 2
            print('JUDGE FAILURE: previous result explicitly marked, never substituted in ranking')
            write_rows([{'input':{'question':'NEW-FIRST'},'expected':{'answer':'changed'}}]+rows[1:])
            os.utime(exam, (1, 1))  # same cardinality and older mtime: only identity detects it
            response=await get('analysis')
            assert response['ranking']==[] and response['hardest']==[]
            assert all(m['stale'] and m['score'] is None and not m['groups'] for m in response['models'])
            assert response['questions'][0]['question']=='NEW-FIRST'
            assert all(not q['models'] for q in response['questions'])
            print('EXAM EDIT: same row count / older mtime, no answers attached')
            write_rows([{'input':{}}])
            failed=await evaluate(['global.fixture-dataset'],'judge-actual')
            assert failed['state']=='error' and 'score' not in failed['models'][0]
            print('DATASET_FAILURE',failed['models'][0]['error']['code'])

if __name__ == "__main__":
    asyncio.run(main())
