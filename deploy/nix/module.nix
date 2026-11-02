# NixOS module for Jackfield.
#
#   imports = [ ./deploy/nix/module.nix ];
#
#   services.jackfield = {
#     enable = true;
#     settings = {
#       server.port = 8790;
#       upstreams.github = {
#         transport = "http";
#         url = "https://api.githubcopilot.com/mcp/";
#         token = "\${file:/var/lib/jackfield/secrets/github.token}";
#       };
#       clients.laptop = {
#         key = "\${file:/var/lib/jackfield/secrets/key-laptop}";
#         upstreams = [ "*" ];
#       };
#     };
#   };
#
# The settings go to the Nix store, so no secret may appear in them: write
# ${file:...} and keep the files out of the store, owned by the service user.
{ config, lib, pkgs, ... }:

let
  cfg = config.services.jackfield;
  format = pkgs.formats.json { };
  configFile = if cfg.configFile != null then cfg.configFile else format.generate "jackfield.json" cfg.settings;

  hardening = {
    NoNewPrivileges = true;
    PrivateTmp = true;
    PrivateDevices = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectControlGroups = true;
    ProtectClock = true;
    RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
    RestrictNamespaces = true;
    RestrictSUIDSGID = true;
    LockPersonality = true;
    SystemCallArchitectures = "native";
  };
in
{
  options.services.jackfield = {
    enable = lib.mkEnableOption "the Jackfield MCP gateway";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { }";
      description = "The Jackfield package to run.";
    };

    settings = lib.mkOption {
      type = format.type;
      default = { };
      description = ''
        The gateway configuration, as an attribute set. Written to the Nix
        store, which is world-readable: reference every secret with
        `''${file:/path}` instead of inlining it.
      '';
    };

    configFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Use this file instead of `settings`.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "jackfield";
      description = "User the gateway runs as.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "jackfield";
      description = "Group the gateway runs as.";
    };

    secretsDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/jackfield/secrets";
      description = ''
        Directory the service may read secrets from. Created with mode 0700
        owned by the service user; put key and token files here yourself.
      '';
    };

    extraReadOnlyPaths = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Extra paths the gateway may read, for secrets kept elsewhere.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Open the listen port. Off by default: a gateway holds every key you
        own, so it belongs behind a reverse proxy with TLS, or on a private
        network, not on the open internet by accident.
      '';
    };

    executor = {
      enable = lib.mkEnableOption "a Jackfield executor on this machine";

      settings = lib.mkOption {
        type = format.type;
        default = { };
        description = "Upstreams this executor serves (same format as the gateway).";
      };

      tokenFile = lib.mkOption {
        type = lib.types.path;
        description = "File holding the token the core authenticates with.";
      };

      host = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1";
        description = "Listen address of the executor.";
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = 8795;
        description = "Listen port of the executor.";
      };
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      users.users.${cfg.user} = lib.mkIf (cfg.user == "jackfield") {
        isSystemUser = true;
        group = cfg.group;
        home = "/var/lib/jackfield";
      };
      users.groups.${cfg.group} = lib.mkIf (cfg.group == "jackfield") { };

      systemd.tmpfiles.rules = [
        "d /var/lib/jackfield 0750 ${cfg.user} ${cfg.group} -"
        "d ${cfg.secretsDir} 0700 ${cfg.user} ${cfg.group} -"
      ];

      systemd.services.jackfield = {
        description = "Jackfield MCP gateway";
        wantedBy = [ "multi-user.target" ];
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];

        serviceConfig = hardening // {
          ExecStart = "${cfg.package}/bin/jackfield serve --config ${configFile}";
          User = cfg.user;
          Group = cfg.group;
          Restart = "on-failure";
          RestartSec = "2s";
          StateDirectory = "jackfield";
          ReadWritePaths = [ "/var/lib/jackfield" ];
          ReadOnlyPaths = [ cfg.secretsDir ] ++ cfg.extraReadOnlyPaths;
        };
      };

      networking.firewall.allowedTCPPorts =
        lib.mkIf cfg.openFirewall [ (cfg.settings.server.port or 8790) ];
    }

    (lib.mkIf cfg.executor.enable {
      systemd.services.jackfield-executor = {
        description = "Jackfield executor";
        wantedBy = [ "multi-user.target" ];
        after = [ "network-online.target" ];

        serviceConfig = hardening // {
          ExecStart = lib.concatStringsSep " " [
            "${cfg.package}/bin/jackfield-executor"
            "--config ${format.generate "jackfield-executor.json" cfg.executor.settings}"
            "--token-file ${cfg.executor.tokenFile}"
            "--host ${cfg.executor.host}"
            "--port ${toString cfg.executor.port}"
          ];
          User = cfg.user;
          Group = cfg.group;
          Restart = "on-failure";
          RestartSec = "2s";
          StateDirectory = "jackfield-executor";
          ReadWritePaths = [ "/var/lib/jackfield-executor" ];
          ReadOnlyPaths = [ cfg.executor.tokenFile ];
          # Executors exist to run things: child processes need a shell and a home.
          ProtectSystem = "full";
        };
      };
    })
  ]);
}
