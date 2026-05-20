# SSL Certificate Renewal Guide — mycroshop.com

> **Server:** WHM/cPanel (Apache)
> **Certificate Type:** Let's Encrypt Wildcard
> **Covers:** `mycroshop.com` + `*.mycroshop.com`
> **Validity:** 90 days — renew every ~60 days

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Step 1 — Check Current Certificate Status](#step-1--check-current-certificate-status)
4. [Step 2 — Start a Screen Session](#step-2--start-a-screen-session)
5. [Step 3 — Run Certbot DNS Challenge](#step-3--run-certbot-dns-challenge)
6. [Step 4 — Create DNS TXT Records](#step-4--create-dns-txt-records)
7. [Step 5 — Verify DNS Propagation](#step-5--verify-dns-propagation)
8. [Step 6 — Complete the Certbot Process](#step-6--complete-the-certbot-process)
9. [Step 7 — Install Certificate in WHM](#step-7--install-certificate-in-whm)
10. [Step 8 — Install on All Subdomains](#step-8--install-on-all-subdomains)
11. [Step 9 — Restart Apache](#step-9--restart-apache)
12. [Step 10 — Verify Everything Works](#step-10--verify-everything-works)
13. [Troubleshooting](#troubleshooting)
14. [Renewal Schedule](#renewal-schedule)

---

## Overview

MycroShop uses a **Let's Encrypt wildcard SSL certificate** that covers the root domain
and all subdomains:

```
mycroshop.com
*.mycroshop.com  (backend, app, api, stride, and any other subdomain)
```

Because the server runs **WHM/cPanel with Apache**, the renewal process has two parts:

1. **Certbot** — downloads and saves the new certificate files
2. **WHM** — installs those certificate files into Apache for each domain/subdomain

> ⚠️ **Important:** WHM does NOT automatically pick up certbot renewals.
> You must manually install the new cert in WHM after every renewal.

---

## Prerequisites

- SSH access to the server as root
- Access to WHM (Web Host Manager)
- Access to the DNS provider where `mycroshop.com` is managed (e.g. Namecheap)
- Certbot installed on the server

---

## Step 1 — Check Current Certificate Status

SSH into the server and run:

```bash
sudo certbot certificates
```

**Expected output:**

```
Found the following certs:
  Certificate Name: mycroshop.com
    Domains: mycroshop.com *.mycroshop.com
    Expiry Date: 2026-08-16 09:00:50+00:00 (VALID: 89 days)
    Certificate Path: /etc/letsencrypt/live/mycroshop.com/fullchain.pem
    Private Key Path: /etc/letsencrypt/live/mycroshop.com/privkey.pem
```

Note the expiry date. Start the renewal process when **30 days or fewer remain**.

> ⚠️ If you see `Another instance of Certbot is already running`:
> ```bash
> sudo pkill -f certbot
> sudo rm -f /var/lib/letsencrypt/.certbot.lock
> sudo rm -f /tmp/certbot.lock
> ```
> Then verify no process is left: `ps aux | grep certbot`

---

## Step 2 — Start a Screen Session

A screen session keeps the process alive even if your SSH connection drops:

```bash
screen -S certbot-renew
```

> If you get disconnected during the process, reconnect with:
> ```bash
> screen -r certbot-renew
> ```

---

## Step 3 — Run Certbot DNS Challenge

Wildcard certificates require a DNS challenge (not HTTP). Run:

```bash
sudo certbot certonly \
  --manual \
  --preferred-challenges dns \
  -d mycroshop.com \
  -d '*.mycroshop.com'
```

Certbot will **pause twice** and display something like:

```
Please deploy a DNS TXT record under the name:
_acme-challenge.mycroshop.com

with the following value:
abc123XYZsomeLongRandomString

Press Enter to Continue
```

**DO NOT press Enter yet.** Copy the value and go to Step 4.

> Certbot pauses **twice** — once for `mycroshop.com` and once for `*.mycroshop.com`.
> Both use the same TXT record name but with **different values**.
> You need both TXT records live before pressing Enter the second time.

---

## Step 4 — Create DNS TXT Records

Log into your DNS provider (Namecheap / Cloudflare / etc.) and create:

| Type | Host | Value | TTL |
|------|------|-------|-----|
| TXT | `_acme-challenge` | (value 1 from certbot) | 300 |
| TXT | `_acme-challenge` | (value 2 from certbot) | 300 |

> **Namecheap note:** Use just `_acme-challenge` as the Host — Namecheap appends
> the domain automatically. Do NOT enter `_acme-challenge.mycroshop.com`.

> **Both records have the same Host name but different Values.**
> Your DNS provider should allow two TXT records with the same name.

---

## Step 5 — Verify DNS Propagation

**Do not press Enter in certbot until the TXT records are visible.**

### Option A — From the server (most reliable)

```bash
dig TXT _acme-challenge.mycroshop.com @8.8.8.8 +short
```

Wait until you see both values returned before continuing.

### Option B — Online checker

```
https://dnschecker.org/#TXT/_acme-challenge.mycroshop.com
```

Wait until the values appear on at least 5–6 nodes globally.

### Option C — From Windows PowerShell

```powershell
Resolve-DnsName -Name "_acme-challenge.mycroshop.com" -Type TXT -Server 1.1.1.1
```

---

## Step 6 — Complete the Certbot Process

Once DNS propagation is confirmed:

1. Go back to your screen session: `screen -r certbot-renew`
2. Press **Enter** for the first challenge
3. Certbot will pause again for the second challenge — verify that value is also propagated
4. Press **Enter** for the second challenge

**Success output:**

```
Congratulations! Your certificate and chain have been saved at:
/etc/letsencrypt/live/mycroshop.com/fullchain.pem

Key Type: RSA
Expiry Date: 2026-08-16 (VALID: 89 days)
```

Confirm the new cert is saved:

```bash
sudo certbot certificates
```

Check the expiry date is now ~90 days from today.

---

## Step 7 — Install Certificate in WHM

> ⚠️ **WHM does not auto-apply certbot renewals.** You must install manually.

### Get the certificate file contents

```bash
# Certificate — paste this into the Certificate (CRT) field in WHM
cat /etc/letsencrypt/live/mycroshop.com/fullchain.pem

# Private Key — paste this into the Private Key (KEY) field in WHM
cat /etc/letsencrypt/live/mycroshop.com/privkey.pem
```

### Install in WHM

```
WHM → SSL/TLS → Install an SSL Certificate on a Domain
```

Fill in the fields:

| WHM Field | What to paste |
|-----------|---------------|
| **Domain** | `mycroshop.com` |
| **Certificate (CRT)** | Full contents of `fullchain.pem` |
| **Private Key (KEY)** | Full contents of `privkey.pem` |
| **CA Bundle** | Leave **blank** — fullchain.pem already includes the CA chain |

Click **Install** and confirm.

---

## Step 8 — Install on All Subdomains

> ⚠️ **Critical WHM behaviour:** Even though the cert is a wildcard, WHM creates
> a separate Apache VirtualHost for each subdomain with its own SSL config.
> The wildcard does NOT automatically apply to subdomains that have their own
> certificate entry in WHM. You must install the cert on each one individually.

### Check which subdomains need updating

From SSH, run this to see each subdomain's current expiry:

```bash
for domain in mycroshop.com backend.mycroshop.com stride.mycroshop.com app.mycroshop.com api.mycroshop.com; do
  echo -n "$domain: "
  echo | openssl s_client -connect $domain:443 -servername $domain 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null
done
```

Or check in WHM:

```
WHM → SSL/TLS → Manage SSL Hosts
```

Any subdomain showing the **old expiry date** needs the new cert installed.

### Install on each expired subdomain

Repeat the WHM install step for every subdomain:

```
WHM → SSL/TLS → Install an SSL Certificate on a Domain
Domain: backend.mycroshop.com     ← change for each subdomain
```

Use the **exact same** `fullchain.pem` and `privkey.pem` for all subdomains —
one wildcard cert covers them all.

**Current subdomains to check on every renewal:**

- `mycroshop.com`
- `backend.mycroshop.com`
- `stride.mycroshop.com`
- _(add any new subdomains here as they are created)_

---

## Step 9 — Restart Apache

### Via WHM (recommended)

```
WHM → Home → Restart Services → HTTP Server (Apache)
```

### Via SSH

```bash
sudo /scripts/restartsrv_apache
```

Or:

```bash
sudo systemctl restart httpd
```

---

## Step 10 — Verify Everything Works

### Check cert being served by Apache

```bash
echo | openssl s_client -connect mycroshop.com:443 -servername mycroshop.com 2>/dev/null \
  | openssl x509 -noout -dates
```

Expected:
```
notBefore=May 18 09:00:51 2026 GMT
notAfter=Aug 16 09:00:50 2026 GMT
```

### Check all subdomains at once

```bash
for domain in mycroshop.com backend.mycroshop.com stride.mycroshop.com; do
  echo -n "$domain: "
  echo | openssl s_client -connect $domain:443 -servername $domain 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null
done
```

All should show the new expiry date.

### Online verification

```
https://www.ssllabs.com/ssltest/analyze.html?d=mycroshop.com
https://www.sslshopper.com/ssl-checker.html#hostname=backend.mycroshop.com
```

All domains should show green with the new expiry date.

---

## Troubleshooting

### "Another instance of Certbot is already running"

```bash
sudo pkill -f certbot
sudo rm -f /var/lib/letsencrypt/.certbot.lock
sudo rm -f /tmp/certbot.lock
ps aux | grep certbot   # confirm nothing is running
```

### Browser still shows "Not Secure" after installing cert

This is almost always a browser cache issue if the openssl check shows the right date:

```bash
echo | openssl s_client -connect mycroshop.com:443 -servername mycroshop.com 2>/dev/null \
  | openssl x509 -noout -dates
```

If dates are correct, clear browser cache:
- Hard refresh: `Ctrl + Shift + R`
- Open incognito window: `Ctrl + Shift + N`
- Clear SSL cache in browser settings

### Subdomain still shows expired cert after WHM install

WHM installed the cert for that subdomain but Apache wasn't restarted. Restart Apache:

```bash
sudo /scripts/restartsrv_apache
```

### DNS TXT record not propagating

- Double check the record was saved in your DNS provider
- Wait 5–10 minutes — free DNS providers can be slow
- Try a different DNS checker: `https://toolbox.googleapps.com/apps/dig/#TXT/_acme-challenge.mycroshop.com`
- Use a lower TTL (300 seconds) next time to speed up propagation

### Screen session lost / SSH disconnected during certbot

```bash
screen -ls                    # list all sessions
screen -r certbot-renew       # reattach if still alive
screen -X -S certbot-renew quit   # kill dead session, then start fresh
```

---

## Renewal Schedule

| Event | Date |
|-------|------|
| Last renewed | May 18, 2026 |
| Certificate expires | August 16, 2026 |
| **Start renewal by** | **July 17, 2026** (30 days before expiry) |

> Set a calendar reminder for **mid-July 2026** to begin the renewal process.
> Do not wait until it expires — browsers will block users from accessing the site.

---

## Certificate File Locations

```
/etc/letsencrypt/live/mycroshop.com/fullchain.pem   ← Certificate (paste into WHM CRT field)
/etc/letsencrypt/live/mycroshop.com/privkey.pem     ← Private Key (paste into WHM KEY field)
/etc/letsencrypt/live/mycroshop.com/cert.pem        ← Certificate only (without chain)
/etc/letsencrypt/live/mycroshop.com/chain.pem       ← CA chain only
```

---

## Quick Reference — Full Renewal Checklist

```
[ ] SSH into server
[ ] sudo certbot certificates — check expiry
[ ] screen -S certbot-renew
[ ] sudo certbot certonly --manual --preferred-challenges dns -d mycroshop.com -d '*.mycroshop.com'
[ ] Copy TXT value 1 from certbot output
[ ] Add TXT record 1 in DNS provider (_acme-challenge)
[ ] Wait for certbot to show TXT value 2
[ ] Add TXT record 2 in DNS provider (same host, different value)
[ ] Verify propagation: dig TXT _acme-challenge.mycroshop.com @8.8.8.8 +short
[ ] Press Enter in certbot (twice)
[ ] sudo certbot certificates — confirm new expiry date
[ ] cat /etc/letsencrypt/live/mycroshop.com/fullchain.pem — copy contents
[ ] cat /etc/letsencrypt/live/mycroshop.com/privkey.pem — copy contents
[ ] WHM → SSL/TLS → Install SSL → mycroshop.com — paste cert + key
[ ] WHM → SSL/TLS → Install SSL → backend.mycroshop.com — paste cert + key
[ ] WHM → SSL/TLS → Install SSL → stride.mycroshop.com — paste cert + key
[ ] WHM → SSL/TLS → Install SSL → (repeat for all subdomains)
[ ] WHM → Restart Services → HTTP Server (Apache)
[ ] Verify: echo | openssl s_client -connect mycroshop.com:443 -servername mycroshop.com 2>/dev/null | openssl x509 -noout -dates
[ ] Update renewal date in this document
```
