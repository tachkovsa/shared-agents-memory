# Extra CA certificates

This directory holds root CA certificates that Node's default trust store does
not include. It exists for the **GigaChat** embeddings provider
(`EMBEDDINGS_PROVIDER=gigachat`): Sber's API endpoints
(`ngw.devices.sberbank.ru`, `gigachat.devices.sberbank.ru`) present a TLS chain
signed by the **Russian Ministry of Digital Development (Минцифры) root CA**.
Without that CA, every embedding call fails with:

```
Error: self-signed certificate in certificate chain (SELF_SIGNED_CERT_IN_CHAIN)
```

No other provider needs this. OpenRouter/OpenAI/vLLM/TEI/Yandex all chain to
public roots Node already trusts, so leave `NODE_EXTRA_CA_CERTS` unset for them.

## Setup

1. **`russian_trusted_root_ca.pem` is committed to this directory.** It is the
   PUBLIC Минцифры root CA (subject `CN=Russian Trusted Root CA`, valid
   2022–2032) — not a secret — so you don't have to hunt it down behind a VPN.
   The Dockerfile bakes it into the image at `/app/certs`. If you ever need to
   refresh it, the official source is
   <https://www.gosuslugi.ru/crt> → «Сертификат «Минцифры России» (корневой)».
   `.gitignore` keeps every OTHER cert/key in this dir untracked.

2. Point Node at it via `NODE_EXTRA_CA_CERTS`. Two ways:

   **A. Bind-mount into the container (recommended for the GHCR prod image).**
   In your `docker-compose` override for the `mcp` service:

   ```yaml
   services:
     mcp:
       environment:
         NODE_EXTRA_CA_CERTS: /app/certs/russian_trusted_root_ca.pem
       volumes:
         - ./certs/russian_trusted_root_ca.pem:/app/certs/russian_trusted_root_ca.pem:ro
   ```

   **B. Bake into a locally-built image.** The `Dockerfile` copies this whole
   directory to `/app/certs`, so if the PEM is present at build time it ships in
   the image. Then set `NODE_EXTRA_CA_CERTS=/app/certs/russian_trusted_root_ca.pem`
   in `.env`.

3. For local `npm run dev` (stdio), export it in your shell / `.env`:

   ```
   NODE_EXTRA_CA_CERTS=./certs/russian_trusted_root_ca.pem
   ```

## Verify

After wiring it up, a GigaChat embedding call should succeed instead of raising
`SELF_SIGNED_CERT_IN_CHAIN`. A quick check:

```
NODE_EXTRA_CA_CERTS=./certs/russian_trusted_root_ca.pem \
  node -e "fetch('https://gigachat.devices.sberbank.ru/').then(()=>console.log('TLS ok')).catch(e=>console.error(e.code||e.message))"
```

`TLS ok` (or an HTTP error, not a cert error) means the CA is trusted.
