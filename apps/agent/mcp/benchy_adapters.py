from benchy import providers
from llm_client import ProviderProfile


def for_system(ir, *args, **kwargs):
    adapter = providers.for_system(ir, *args, **kwargs)
    _route(adapter, ir["ai-system"])
    return adapter


def for_grader(ir, *args, **kwargs):
    adapter = providers.for_grader(ir, *args, **kwargs)
    _route(adapter, ir["scoring"]["grader"])
    return adapter


def _route(adapter, system):
    if system["provider"] == "bedrock" and system["model"].startswith("global.openai."):
        adapter.profile = ProviderProfile.OPENAI
