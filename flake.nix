{
  description = "JARVIS center dashboard: a home and infrastructure board with a live AI companion";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: { default = pkgs.callPackage ./nix/package.nix { }; });
      nixosModules.default = import ./nix/module.nix self;
      # `nix flake check` evaluates the service in a minimal system.
      checks.x86_64-linux.module = (nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules = [
          self.nixosModules.default
          { boot.isContainer = true; system.stateVersion = "26.05"; services.center-dashboard.enable = true; }
        ];
      }).config.system.build.toplevel;
    };
}
