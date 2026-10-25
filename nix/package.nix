# The dashboard as a Nix package: builds the single-file page, runs the static checks, and installs
# the zero-dependency server. Run it with `center-dashboard` (see nix/module.nix for the service).
{ lib, stdenvNoCC, nodejs_22, makeWrapper }:
stdenvNoCC.mkDerivation {
  pname = "center-dashboard";
  version = (lib.importJSON ../package.json).version;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [ ../package.json ../src ../server ../tools ../vendor ];
  };
  nativeBuildInputs = [ nodejs_22 makeWrapper ];
  buildPhase = ''
    runHook preBuild
    node tools/build.mjs
    node tools/check.mjs
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/center-dashboard/src $out/bin
    cp -R dist server package.json $out/share/center-dashboard/
    cp src/catalog.mjs $out/share/center-dashboard/src/
    makeWrapper ${nodejs_22}/bin/node $out/bin/center-dashboard \
      --add-flags $out/share/center-dashboard/server/index.mjs
    runHook postInstall
  '';
  meta = {
    description = "JARVIS home and infrastructure dashboard";
    homepage = "https://github.com/schpeterzon/center-dashboard";
    license = lib.licenses.mit;
    mainProgram = "center-dashboard";
  };
}
