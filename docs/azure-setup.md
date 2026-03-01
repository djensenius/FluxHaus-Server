# Azure Resource Setup Guide

This document lists every Azure resource required by FluxHaus-Server and the
credentials you need to obtain for each one.

---

## 1. Azure OpenAI

Used by `AI_PROVIDER=azure-openai` (LLM for `/command`) and
`STT_PROVIDER=azure-openai` (Whisper transcription for `/voice`).

### How to create

1. In the [Azure portal](https://portal.azure.com), search for **Azure OpenAI**
   and create a new resource (select a region where the models you need are
   available — `eastus` or `swedencentral` are usually best-stocked).
2. Once the resource is created, open it and go to **Keys and Endpoint**.

### What you need

| Env var | Where to find it |
|---------|-----------------|
| `AZURE_OPENAI_API_KEY` | **Keys and Endpoint → KEY 1** (or KEY 2) |
| `AZURE_OPENAI_ENDPOINT` | **Keys and Endpoint → Endpoint** (e.g. `https://myresource.openai.azure.com`) |
| `AZURE_OPENAI_API_VERSION` | Use `2024-12-01-preview` (default) or check the [API changelog](https://learn.microsoft.com/azure/ai-services/openai/reference) |

### Model deployments

Open **Azure OpenAI Studio → Deployments** and create two deployments:

| Purpose | Model to deploy | Suggested deployment name | Env var |
|---------|----------------|--------------------------|---------|
| LLM (`AI_PROVIDER=azure-openai`) | `gpt-4o` | `gpt-4o` | `AZURE_OPENAI_DEPLOYMENT` |
| STT (`STT_PROVIDER=azure-openai`) | `whisper` | `whisper` | `AZURE_OPENAI_STT_DEPLOYMENT` |

> **Note:** Whisper is not available in all regions. Check the
> [model availability table](https://learn.microsoft.com/azure/ai-services/openai/concepts/models)
> before choosing a region.

---

## 2. Azure Cognitive Services Speech

Used by `STT_PROVIDER=azure` (speech-to-text) and `TTS_PROVIDER=azure`
(text-to-speech). This is a separate service from Azure OpenAI — it uses
Microsoft's proprietary speech models rather than Whisper.

### How to create

1. Search for **Speech** (or **Azure AI services**) in the Azure portal and
   create a **Speech** resource.
2. Choose the same region you plan to use in `AZURE_SPEECH_REGION`.

### What you need

| Env var | Where to find it |
|---------|-----------------|
| `AZURE_SPEECH_KEY` | **Keys and Endpoint → KEY 1** |
| `AZURE_SPEECH_REGION` | The short region code you selected (e.g. `eastus`) |
| `AZURE_SPEECH_LANGUAGE` | Optional. BCP-47 language code for STT (default: `en-US`) |
| `AZURE_TTS_VOICE` | Optional. Neural voice name for TTS (default: `en-US-JennyNeural`). Browse voices at [Speech Studio](https://speech.microsoft.com/portal) |

---

## 3. Choosing Between Azure OpenAI and Azure Cognitive Services Speech

| Capability | Azure OpenAI | Azure Cognitive Services Speech |
|---|---|---|
| **LLM (GPT-4o, etc.)** | ✅ `AI_PROVIDER=azure-openai` | ✗ |
| **STT (transcription)** | ✅ Whisper — `STT_PROVIDER=azure-openai` | ✅ Proprietary — `STT_PROVIDER=azure` |
| **TTS (speech synthesis)** | ✗ | ✅ Neural voices — `TTS_PROVIDER=azure` |

**Recommended all-Azure setup** (two resources, one API key each):

```env
# LLM
AI_PROVIDER=azure-openai
AZURE_OPENAI_API_KEY=<key>
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=gpt-4o

# STT — Whisper via Azure OpenAI (same resource as LLM)
STT_PROVIDER=azure-openai
AZURE_OPENAI_STT_DEPLOYMENT=whisper

# TTS — Azure Cognitive Services Neural voices
TTS_PROVIDER=azure
AZURE_SPEECH_KEY=<key>
AZURE_SPEECH_REGION=eastus
AZURE_TTS_VOICE=en-US-JennyNeural
```

---

## 4. Other Services (non-Azure)

The table below summarises all other external credentials used by FluxHaus-Server.

| Service | Env var(s) | How to obtain |
|---------|-----------|---------------|
| **Anthropic (Claude)** | `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API keys |
| **OpenAI** (direct) | `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com) → API keys |
| **GitHub Copilot** | `GITHUB_TOKEN` | GitHub → Settings → Developer settings → Personal access tokens |
| **Z.ai** | `ZAI_API_KEY`, `ZAI_BASE_URL` | Your Z.ai account |
| **Google AI** (STT/TTS) | `GOOGLE_API_KEY` | [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials. Enable **Cloud Speech-to-Text API** and **Cloud Text-to-Speech API** |
| **ElevenLabs** (TTS) | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | [elevenlabs.io](https://elevenlabs.io) → Profile → API key |
| **Home Assistant** | `HOMEASSISTANT_URL`, `HOMEASSISTANT_TOKEN` | HA → Profile → Long-Lived Access Tokens |
| **Miele** | `mieleClientId`, `mieleSecretId` | [developer.miele.com](https://developer.miele.com) → My Apps |
| **Bosch / Home Connect** | `boschClientId`, `boschSecretId` | [developer.home-connect.com](https://developer.home-connect.com) → Applications |
| **PostgreSQL** | `POSTGRES_URL` | Your hosted or local Postgres instance |
| **InfluxDB** | `INFLUXDB_URL`, `INFLUXDB_TOKEN`, `INFLUXDB_ORG`, `INFLUXDB_BUCKET` | InfluxDB UI → Load Data → API Tokens |
| **OIDC (Authentik)** | `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Authentik admin → Applications → Providers |
