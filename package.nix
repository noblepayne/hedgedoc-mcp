{
  lib,
  buildNpmPackage,
  nodejs,
  makeWrapper,
}:
buildNpmPackage {
  pname = "hedgedoc-mcp";
  version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

  src = ./.;

  # Refresh with: nix run nixpkgs#prefetch-npm-deps -- package-lock.json
  npmDepsHash = "sha256-hIjFlNYNP+5/d5gCqbwq4LnDdpJdAiz4TSWsmZQiFbc=";

  nativeBuildInputs = [nodejs makeWrapper];

  dontNpmBuild = true;

  buildPhase = ''
    runHook preBuild
    npx squint compile
    runHook postBuild
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    node test/version-check.mjs
    node test/error-shape.mjs
    node test/model-subtree.mjs
    node test/affected-span.mjs
    node test/intent.mjs
    node test/section-boundary.mjs
    node test/replace-range.mjs
    node test/pbt-1-gens.mjs
    node test/pbt-2-transform.mjs --runs 300
    node test/pbt-3-invariants.mjs
    node test/pbt-4-replace-lines.mjs
    node test/snapshot-gc.mjs
    node test/retry-safety.mjs
    node test/remote-op-fold.mjs
    node test/bin-launch.mjs
    node test/arg-validation.mjs
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/hedgedoc-mcp $out/bin
    npm prune --omit=dev
    cp -r hedgedoc_mcp $out/lib/hedgedoc-mcp/
    cp -r node_modules $out/lib/hedgedoc-mcp/
    # The compiled output imports the Squint runtime at load time. It is a
    # runtime dependency (not just a compiler), so prove it survived the prune.
    (cd $out/lib/hedgedoc-mcp && ${nodejs}/bin/node --input-type=module -e \
      "await import('squint-cljs/core.js'); await import('./hedgedoc_mcp/model.mjs')")
    install -Dm644 LICENSE $out/share/licenses/hedgedoc-mcp/LICENSE
    makeWrapper ${nodejs}/bin/node $out/bin/hedgedoc-mcp \
      --add-flags "$out/lib/hedgedoc-mcp/hedgedoc_mcp/multi.mjs" \
      --set NODE_PATH "$out/lib/hedgedoc-mcp/node_modules"
    runHook postInstall
  '';

  meta = {
    description = "CAS-grounded HedgeDoc MCP: read and edit notes without clobbering humans";
    homepage = "https://github.com/noblepayne/hedgedoc-mcp";
    license = lib.licenses.mit;
    mainProgram = "hedgedoc-mcp";
    platforms = lib.platforms.unix;
  };
}
