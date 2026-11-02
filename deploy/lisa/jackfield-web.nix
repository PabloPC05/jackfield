# La landing de Jackfield: jackfield.ppardocotos.com, estática, servida por Caddy.
#
#   navegador ──HTTPS 443──► router de casa ──reenvío──► lisa (Caddy) ──► /var/lib/jackfield-web
#
# - Solo archivos: no hay proceso ni puerto propio, así que no hace falta nada en 127.0.0.1.
# - El contenido no va en este repositorio: se construye en el proyecto (site/dist) y se copia
#   con scp a /var/lib/jackfield-web, que es de `pablo` y lo lee `caddy`.
#       cd ~/MCP_Unico/site && node build.mjs
#       scp dist/* lisa:/var/lib/jackfield-web/
# - El nombre sigue a la IP de casa por `services.cloudflare-dyndns.domains` (la lista se fusiona).
# - CSP sin `unsafe-inline`: la página no carga nada de fuera y su estilo y su script son archivos.
{ ... }:
let
  nombre = "jackfield.ppardocotos.com";
  enCasa = "192.168.1.130"; # la IP de casa, a la que el router reenvía el 443
  raiz = "/var/lib/jackfield-web";
in
{
  systemd.tmpfiles.rules = [
    "d ${raiz} 0755 pablo caddy -"
  ];

  services.cloudflare-dyndns.domains = [ nombre ];

  services.caddy.virtualHosts.${nombre}.extraConfig = ''
    bind ${enCasa}
    tls {
      issuer acme {
        disable_http_challenge
      }
    }
    encode zstd gzip
    header {
      Strict-Transport-Security "max-age=31536000"
      X-Content-Type-Options "nosniff"
      Referrer-Policy "no-referrer"
      Content-Security-Policy "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      Permissions-Policy "geolocation=(), microphone=(), camera=()"
      -Server
    }
    # El HTML se revalida siempre; el estilo y el script llevan el hash de su
    # contenido en el nombre, así que nunca hay una página nueva con un estilo
    # viejo, que es como se rompe un sitio estático justo para quien ya lo visitó.
    # Matchers excluyentes: dos `header` que coincidan con la misma petición se
    # pisan, y gana el último.
    @conHash path /app.*.css /app.*.js
    @sinHash not path /app.*.css /app.*.js
    header @conHash Cache-Control "public, max-age=31536000, immutable"
    header @sinHash Cache-Control "no-cache"
    root * ${raiz}
    file_server
  '';
}
