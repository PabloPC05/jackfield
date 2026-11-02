# Jackfield as a Nix package.
#
# npmDepsHash must match package-lock.json. Get it with:
#   nix run nixpkgs#prefetch-npm-deps -- package-lock.json
#
# Keep package-lock.json in LF: a CRLF checkout changes the hash and the build
# then fails for a reason that has nothing to do with the code.
{ lib, buildNpmPackage, nodejs_22, ... }:

buildNpmPackage (finalAttrs: {
  pname = "jackfield";
  version = "0.1.0";

  src = lib.cleanSource ../..;

  npmDepsHash = lib.fakeHash; # replace with the prefetched hash

  nodejs = nodejs_22;

  # The workspace build emits dist/ for each package.
  npmBuildScript = "build";

  # Tests need to bind a loopback port and spawn child processes.
  doCheck = false;

  meta = {
    description = "A declarative MCP gateway you can run anywhere";
    homepage = "https://github.com/PabloPC05/jackfield";
    license = lib.licenses.mit;
    mainProgram = "jackfield";
    platforms = lib.platforms.unix;
  };
})
