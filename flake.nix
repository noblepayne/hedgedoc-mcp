{
  description = "hedgedoc-mcp — CAS-grounded HedgeDoc MCP";

  inputs.nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
    forAll = fn: nixpkgs.lib.genAttrs systems (system: fn nixpkgs.legacyPackages.${system});
  in {
    packages = forAll (pkgs: {
      default = pkgs.callPackage ./package.nix {};
    });

    apps = forAll (pkgs: {
      default = {
        type = "app";
        program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/hedgedoc-mcp";
        meta = self.packages.${pkgs.stdenv.hostPlatform.system}.default.meta;
      };
    });

    checks = forAll (pkgs: {
      package = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      formatting =
        pkgs.runCommand "check-formatting" {
          nativeBuildInputs = [pkgs.alejandra];
        } ''
          alejandra --check ${self}
          touch $out
        '';
    });

    devShells = forAll (pkgs: {
      default = pkgs.mkShell {
        packages = [pkgs.nodejs pkgs.podman-compose pkgs.jq pkgs.curl];
      };
    });

    formatter = forAll (pkgs: pkgs.alejandra);
  };
}
