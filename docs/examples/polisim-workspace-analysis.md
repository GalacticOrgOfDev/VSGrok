# Example: PoliSim workspace analysis (generated live by VSGrok)

> This report was generated **live by VSGrok** inside VS Code on a real project (PoliSim, a Python 3.14 codebase). Grok used all six workspace tools in one agent run: `get_workspace_overview`, `list_files`, `read_file`, `search_workspace`, `run_command` and `propose_edit`. The file itself was written through `propose_edit`, so it was only saved after the user approved the diff. `.env` was not read. Reproduced unedited below.

---

# PoliSim workspace analysis

Generated to verify the VSGrok tool surface against the open workspace.
Date of inspection: tool session on branch `main`.

## Tool verification

| Tool | Result |
|------|--------|
| `get_workspace_overview` | OK. Workspace name `polisim`, folder `e:\AI Projects\me\polisim`, branch `main`. |
| `list_files` | OK. Top-level tree, `core/**/*.py`, `core/agents/**/*.py`, and a sample of `tests/**/*.py`. |
| `read_file` | OK. Read `README.md` and `pyproject.toml`. |
| `search_workspace` | OK. `def main` found in `main.py`, `launcher.py`, `mcp_server.py`, `generate_problems_report.py`. |
| `run_command` | OK. Exit 0. `Python 3.14.5`, branch `main`, four untracked `*.old` files. |
| `propose_edit` | This file. Applied only if the diff was accepted. |

`.env` is present and was not read. No secrets are included here.

## What this repo is

PoliSim is an MIT-licensed civic fiscal simulator and policy-analysis platform (Galactic Organization of Development / Timothy Harrington Nordyke). The README (status date 29 September 2026) describes two layers:

1. A production fiscal core: healthcare, Social Security, Medicare/Medicaid, revenue, discretionary, interest, and a combined outlook, validated against CBO/SSA/CMS baselines within about ±2–5%.
2. An active Phase 7 remaster: a governed multi-agent swarm under `core/agents/`, plus local inference under `core/inference/` (llama.cpp + Vulkan). External vendor API keys are intentionally out of the core runtime path.

`pyproject.toml` names the package `PoliSim` version `0.1.0`, description "PoliSim Social Network: Governmental Civics, Remastered.", license MIT, `requires-python >= 3.14.5`. The live interpreter matched that floor (`Python 3.14.5`). Classifiers still list 3.9–3.12 as well, so the declared floor and the classifier set disagree.

Pinned runtime deps include pandas 2.2.3, numpy 2.1.3, scipy 1.15.2, matplotlib 3.10.1, PyYAML 6.0.2, pypdf 6.4.2, and llama-cpp-python 0.3.30. Optional extras cover pytest/dev tooling, Streamlit, and FastAPI/uvicorn.

## Layout (high level)

Top-level packages and surfaces seen in the tree:

- `core/` — simulation, policy models, validation, PDF extraction, CBO-oriented loaders.
- `core/agents/` — swarm contracts and engines.
- `core/inference/` — local engine, config, model registry.
- `api/`, `ui/`, `ServerSide/`, `ClientSide/` — REST, dashboard, and related surfaces.
- `tests/`, `scripts/`, `docs/`, `documentation/`, `notebooks/`, `policies/`, `data/`, `databases/`.
- Entry points with `main`: `main.py` (line 466), `launcher.py` (line 572), `mcp_server.py` (line 748), `generate_problems_report.py` (line 57).
- Ops files: `Dockerfile`, `Dockerfile.dashboard`, `docker-compose.yml`, `docker-compose.monitoring.yml`, `config.yaml`, `conftest.py`, `requirements.txt`, `requirements-dev.txt`.

README quick start: `python launcher.py`, or `python main.py --startup-check-only` then `streamlit run ui/dashboard.py` (port 8501). REST is `python api/rest_server.py` (docs at port 5000). Docker: `docker-compose up --build`.

## Agent swarm (files present)

`core/agents/` currently contains:

- Contracts: `base_agent.py`, `models.py`, `types.py`, `factory.py`, `llm_client.py`, `__init__.py`
- Orchestration: `coordinator.py`, `debate_engine.py`, `consensus_engine.py`, `execution_strategies.py`, `judge_agent.py`
- Specialists: `fiscal_agent.py`, `economic_agent.py`, `healthcare_agent.py`, `social_security_agent.py`, `budget_agent.py`

README treats the first four specialists as Tier 1 and `budget_agent.py` as additive (landed 8 September 2026), not yet a silent factory default. Tier 2/3 agents are named as roadmap, not claimed as shipped.

## Git status at inspection

Branch: `main`.

Untracked:

- `core/cbo_scraper.py.old`
- `core/combined_outlook.py.old`
- `core/comparison.py.old`
- `core/context_aware_healthcare.py.old`

No other short-status entries were returned. Open editors: none.

## Notes worth a follow-up (not changed here)

- README says the January 2026 phase doc (`docs/PHASES.md`) still lists Phase 6.2.6 and is stale relative to the swarm remaster.
- Published test bar in the README badge is 417/419. This session did not re-run pytest.
- `pyproject.toml` `[tool.setuptools] packages` lists only `core`, `ui`, and `utils`. Other top-level packages (`api`, and similar) may not be included in an installed distribution.
- Black line length is 200. Pytest is configured for `tests/`, verbose, short tracebacks, and `-n auto`.

## Scope of this file

This note only records what the tools returned. No source files were modified.
