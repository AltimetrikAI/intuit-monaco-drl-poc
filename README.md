# Drools Monaco PoC

A lightweight playground that loads a DRL file into a Monaco editor, lets you edit it, and triggers a background compile/test pipeline. The current setup stubs the compile/test behavior in Node so you can iterate on rules quickly; future work can swap in a real Drools build + BDD runner.

## Project layout
- `src/` – React + Vite UI with Monaco editor and status panels.
- `server/` – Minimal Express server with REST endpoints for loading/saving the DRL file and running the mock pipeline.
- `data/` – Sample artifacts that would normally live in a rule repository (DRL, fact object, BDD notes).

## How it works
1. The server reads `data/rules/sample.drl` and serves it via `GET /api/drl`.
2. The UI loads that content into Monaco on page load.
3. When you press **Save**, the edited text is posted back to `POST /api/drl` and persisted on disk.
4. Pressing **Run compile & tests** sends the current text to `POST /api/run`, which executes:
   - **Compile phase:** basic validation that a package/import/rule exist.
   - **Test phase:** heuristic checks against the sample fact object and BDD doc to show pass/fail feedback.

Both phases return timing + messages so the UI can render status chips and any warnings/errors.

## Getting started
> **Note:** Installing npm packages requires access to the npm registry. If your environment blocks it, mirror the packages or set the correct npm registry before running `npm install`.

```bash
npm install
npm run dev        # starts Express on :4000 and Vite on :5173 via proxy
```

### Building for production
```bash
npm run build
npm run preview    # serves the built UI on :4173 (API proxy still targets :4000)
```

### Available scripts
- `npm run dev` – run server + UI together (via `concurrently`).
- `npm run build` – build the UI bundle.
- `npm run preview` – serve the built UI locally.
- `npm run lint` – type-check the front end.
- `npm run start` – start only the API server (expects `dist/` to exist for static assets).

## API
- `GET /api/drl` – returns the current DRL file.
- `POST /api/drl` – saves raw DRL text.
- `POST /api/run` – runs the mock compile/test pipeline and returns structured results.

## Extending toward real Drools execution
- Swap `server/pipeline.js` for a process that shells out to Maven/Gradle to build and execute Drools.
- Replace the heuristic tests with calls into your BDD runner (e.g., Cucumber) or unit tests.
- Point `RULE_PATH`, `FACT_PATH`, and `TEST_DOC_PATH` at your configuration repository checkout.

