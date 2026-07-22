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

1. Download the Минцифры root CA (PEM). Official source:
   <https://www.gosuslugi.ru/crt> → «Сертификат «Минцифры России» (корневой)».
   Save it here as `russian_trusted_root_ca.pem`. (Not committed — see
   `.gitignore`; ship the CA to your box out of band.)

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
