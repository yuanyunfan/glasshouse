# Mobil QR-kode tilgang

## Slik fungerer det

Glasshouse starter en HTTP-server og genererer en **LAN-adresse** (f.eks. `http://192.168.1.100:7008`). Skann QR-koden for å få tilgang til Claude Code fra telefonen via det samme WiFi-nettverket.

## Hvorfor kan jeg ikke koble til?

1. **Ikke på samme nettverk** — Telefon og datamaskin må være på samme WiFi (samme ruter/samme nettverksnavn)
2. **Brannmur-blokkering** — Systemets brannmur kan blokkere innkommende tilkoblinger
3. **Bedriftsnettverk-isolasjon** — AP-isolasjon kan hindre kommunikasjon mellom enheter
4. **VPN-forstyrrelse** — En VPN kan forstyrre nettverksruten

## Sikkerhetsadvarsel

> ⚠️ Glasshouses LAN-tjeneste er tilgjengelig for alle enheter på samme nettverk.

- Vær forsiktig på **offentlig WiFi**
- Glasshouse bruker **token-autentisering** for å beskytte LAN-tilgang
- Anbefales å bruke på pålitelige nettverk

## Utenfor LAN

- **Tunnelverktøy** — frp, ngrok, Tailscale osv.
- **Glasshouse plugins** — Konfigurer proxy-mellomvare via plugin-systemet
