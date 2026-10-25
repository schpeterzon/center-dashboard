# NixOS service for the dashboard.
#
#   services.center-dashboard = {
#     enable = true;
#     environmentFile = "/etc/secrets/center-dashboard.env";   # optional: CF_ACCESS_*, JARVIS_PASSWORD, …
#   };
#
# The first start prints a setup code (journalctl -u center-dashboard, or /var/lib/center-dashboard/setup-code).
# To use a Claude subscription, set `user` to the account that ran `claude` and signed in, and put
# the CLI on the service's PATH with `cliPackages`.
self:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.center-dashboard;
in
{
  options.services.center-dashboard = {
    enable = lib.mkEnableOption "the JARVIS center dashboard";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "Dashboard package.";
    };
    host = lib.mkOption { type = lib.types.str; default = "127.0.0.1"; description = "Address to listen on. Keep loopback behind a tunnel or reverse proxy."; };
    port = lib.mkOption { type = lib.types.port; default = 8790; description = "Port to listen on (the Harness uses 8787)."; };
    dataDir = lib.mkOption { type = lib.types.str; default = "/var/lib/center-dashboard"; description = "Settings, encrypted secrets and sessions."; };
    user = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Run as this existing user (needed for subscription CLIs signed in under that user). Null runs as a dedicated system user.";
    };
    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional root-owned environment file, for example CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, JARVIS_AUTH or JARVIS_SECRET_KEY.";
    };
    trustProxy = lib.mkOption { type = lib.types.bool; default = false; description = "Trust X-Forwarded-*/CF-Connecting-IP. Enable only behind a tunnel or proxy."; };
    allowToolClis = lib.mkOption { type = lib.types.bool; default = false; description = "Allow subscription CLIs that keep a read-only shell tool (Codex). See SECURITY.md."; };
    cliPackages = lib.mkOption { type = lib.types.listOf lib.types.package; default = [ ]; description = "Packages put on the service PATH, for example a claude-code or codex package."; };
  };

  config = lib.mkIf cfg.enable {
    users.users = lib.mkIf (cfg.user == null) {
      center-dashboard = { isSystemUser = true; group = "center-dashboard"; home = cfg.dataDir; };
    };
    users.groups = lib.mkIf (cfg.user == null) { center-dashboard = { }; };

    systemd.tmpfiles.rules = [ "d ${cfg.dataDir} 0700 ${if cfg.user == null then "center-dashboard" else cfg.user} - - -" ];

    systemd.services.center-dashboard = {
      description = "JARVIS center dashboard";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      path = cfg.cliPackages;
      environment = {
        HOST = cfg.host;
        PORT = toString cfg.port;
        JARVIS_DATA = cfg.dataDir;
        NODE_ENV = "production";
      } // lib.optionalAttrs cfg.trustProxy { JARVIS_TRUST_PROXY = "1"; }
        // lib.optionalAttrs cfg.allowToolClis { JARVIS_ALLOW_TOOL_CLIS = "1"; };
      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        User = if cfg.user == null then "center-dashboard" else cfg.user;
        Group = lib.mkIf (cfg.user == null) "center-dashboard";
        EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;
        Restart = "on-failure";
        RestartSec = 5;
        UMask = "0077";
        # Hardening. A subscription CLI needs its own login state in the user's home directory.
        NoNewPrivileges = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectSystem = "strict";
        ProtectHome = if cfg.user == null then true else false;
        ReadWritePaths = [ cfg.dataDir ];
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        SystemCallArchitectures = "native";
        CapabilityBoundingSet = "";
      };
    };
  };
}
