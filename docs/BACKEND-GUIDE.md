# Leapify Backend Setup Guide

This guide walks through the process of obtaining all required API keys and setting up your environment for Leapify.

## 1. Local Environment Setup

Copy `.dev.vars.example` to `.dev.vars`:

```bash
cp .dev.vars.example .dev.vars
```

---

## 2. Infrastructure Bindings (Cloudflare)

You must create these resources in your Cloudflare dashboard and update `wrangler.toml`:

- **D1 Database**: `wrangler d1 create leapify`
- **KV Namespace**: `wrangler kv namespace create LEAPIFY_KV`
- **Queue**: Create `leapify-email-queue` and `leapify-email-dlq` in the Queues dashboard.
- **R2 Bucket** (Optional): `wrangler r2 bucket create leapify-files`

---

## 3. Obtaining Service API Keys

### [Firebase (Authentication)](https://console.firebase.google.com/)

Leapify uses Firebase to verify student JWTs.

1. Create a project in the Firebase Console.
2. Go to **Settings** (gear icon).
3. `FIREBASE_PROJECT_ID`: Found on the **General** tab.
4. `FIREBASE_WEB_API_KEY`: Found on the **General** tab under "Web API Key".

### [Google Forms (Slots & Registration)](https://console.cloud.google.com/)

Leapify tracks real-time slots via Google Forms Webhooks.

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Search for and **enable the Google Forms API**.
3. Go to **IAM & Admin > Service Accounts**.
4. Create a Service Account, then go to **Keys > Add Key > Create New Key (JSON)**.
5. **CRITICAL: Grant Form Access**:
   - Copy the `client_email` from your service account JSON.
   - Go to every Google Form you want Leapify to track.
   - Click **More (three dots) > Add collaborators**.
   - Paste the service account email and grant it **Editor** access.
6. `GFORMS_SERVICE_ACCOUNT_JSON`: Paste the content of that JSON file into `.dev.vars` (as a single-quoted string if it contains multiple lines).
7. `GFORMS_WEBHOOK_SECRET`: A random 32-character hex string. Generate it using:

   ```bash
   openssl rand -base64 32
   ```

### [Contentful (CMS)](https://app.contentful.com/)

Leapify fetches event metadata and FAQs from Contentful.

1. Go to **Settings > API keys**.
2. Create a new Content Delivery API key.
3. `CONTENTFUL_SPACE_ID`: Found in the API key page.
4. `CONTENTFUL_ACCESS_TOKEN`: The **Content Delivery API - access token** (used for fetching published content).
   - _Note: Do not use the "Content Preview API" token unless you are specifically setting up a preview environment._
5. `CONTENTFUL_ENVIRONMENT`: Usually `master`.

### [Amazon SES (Primary Email)](https://console.aws.amazon.com/ses/)

1. **Identify and Verify Sender**:
   - Go to the [Amazon SES Console](https://console.aws.amazon.com/ses/).
   - Click **Configuration > Identities** in the left sidebar.
   - Click **Create identity**.
   - **Option A (Domain - Recommended)**: Enter your domain (e.g. `yourdomain.com`). AWS will give you several CNAME records to add to your DNS (Cloudflare/GoDaddy). Once verified, you can use _any_ address at that domain (e.g. `noreply@yourdomain.com`).
   - **Option B (Email Address)**: Enter a single email (e.g. `noreply@yourdomain.com`). AWS will send you a verification link. Once clicked, you can use that _exact_ address.
   - **Form Options**:
     - **Default configuration set**: Leave unchecked (not needed for basic setup).
     - **Assign to a tenant**: Leave as default/None (unless you are an MSP).
     - **DKIM Settings**:
       - **Identity type**: Domain (if Option A) or Email address (if Option B).
       - **Easy DKIM**: Leave **Enabled** (Recommended).
       - **DKIM signatures**: Leave **Enabled**.
       - **DKIM key length**: Choose **RSA_2048_BIT** (Recommended for security).
     - **Custom MAIL FROM domain**: Recommended for **DMARC compliance**, but can be skipped initially. If enabled, it must be a subdomain (e.g., `mail.yourdomain.com`).
   - `SES_FROM_ADDRESS`: The verified email address you intend to use for outgoing mail.
   - _Tip: Don't forget to complete DKIM verification in the identity's settings to ensure your emails don't go to spam._
2. **Set Region**:
   - `SES_REGION`: The region shown in your AWS console (e.g., `us-east-1` or `ap-southeast-1`).
3. **Create IAM User & Keys**:
   - Go to the [IAM Console](https://console.aws.amazon.com/iam/).
   - Go to **Users > Create user**.
   - Name it `leapify-backend`.
   - In the "Set permissions" step, choose **Attach policies directly**.
   - Search for and check **AmazonSESFullAccess** (or create a custom policy with `ses:SendEmail`).
   - After creating the user, click on the user name -> **Security credentials** tab.
   - Scroll to **Access keys** and click **Create access key**.
   - Select **Application running outside AWS**.
   - Copy your `SES_ACCESS_KEY_ID` and `SES_SECRET_ACCESS_KEY`.
4. **DNS Records (Mandatory)**:
   - After creating the identity, go to the identity's **Authentication** tab.
   - Publish these records to your DNS provider (e.g., Cloudflare):
     - **DKIM**: Add the **3 CNAME records** provided by SES.
     - **MAIL FROM**: If you enabled a custom MAIL FROM domain, add the **MX** and **TXT** (SPF) records provided.
     - **DMARC**: Add a **TXT** record for `_dmarc.yourdomain.com` (e.g., `v=DMARC1; p=none;`).
   - Your identity status will change from "Pending" to **"Verified"** once these are detected (usually within 10-60 minutes).
5. **Final Values**:
   - `SES_REGION`: Your AWS region (e.g. `ap-southeast-1`).
   - `SES_ACCESS_KEY_ID`: Your IAM user's Access Key.
   - `SES_SECRET_ACCESS_KEY`: Your IAM user's Secret Key (Save this securely!).
   - `SES_FROM_ADDRESS`: Your verified sender address (e.g., `noreply@yourdomain.com`).
   - `EMAIL_FROM_NAME`: (Optional) The display name for the sender (e.g., `Leapify`).

### [Resend (Optional Email Fallback)](https://resend.com/)

1. Create an account and verify your domain.
2. Go to **API Keys** and create a new key.
3. `RESEND_API_KEY`: Starts with `re_`.
4. `RESEND_FROM_ADDRESS`: Your verified sender address.

---

## 4. Internal Security

Leapify uses a shared secret to verify internal webhook calls from Google.

- `INTERNAL_API_SECRET`: Generate a random 32-character hex string:

  ```bash
  openssl rand -base64 32
  ```

---

## 5. Deployment

When deploying to production, set these values using `wrangler secret put`:

```bash
wrangler secret put FIREBASE_PROJECT_ID
wrangler secret put SES_SECRET_ACCESS_KEY
# ... and so on for all keys listed in wrangler.toml.example
```
