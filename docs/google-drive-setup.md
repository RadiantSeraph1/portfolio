# Google Drive for the AI chat (owner only)

The chat at `/ai` can search and read your Google Drive and create Google Docs, Sheets and Slides.
It only works for you: you sign in with your sync password, then connect your Google account once.
Visitors never get any of this.

## One-time setup (about 10 minutes)

1. **Create a Google Cloud project** at https://console.cloud.google.com (any name, e.g. "Radiant AI").
2. **Enable three APIs** (APIs & Services > Library): *Google Drive API*, *Google Sheets API*,
   *Google Slides API*.
3. **OAuth consent screen** (APIs & Services > OAuth consent screen):
   - User type **External**; fill in the app name and your email.
   - Add the scopes `https://www.googleapis.com/auth/drive` and
     `https://www.googleapis.com/auth/userinfo.email`.
   - Set the publishing status to **In production**. If you leave it on *Testing*, Google expires the
     connection every 7 days. Because the app is unverified, Google shows a "hasn't verified this app"
     warning the first time: choose *Advanced > Go to ... (unsafe)*. It is your own app, so that is expected.
4. **Create credentials** (APIs & Services > Credentials > Create credentials > OAuth client ID):
   - Application type **Web application**.
   - Authorized redirect URI: `https://samuelmaclar.com/api/google?action=callback`
     (add the `www.` version too if you use it).
5. **Add two environment variables** in Vercel (Project > Settings > Environment Variables), as
   *Sensitive* values for Production, then redeploy:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
6. Open `/ai`, choose **Sync chats** and sign in, then click **Connect Google Drive** in the sidebar
   and approve. A **Drive** switch appears next to **Web search**.

## What the assistant can and cannot do

| Can | Cannot |
|-----|--------|
| Search your Drive by name and content | Delete, share, move or email anything |
| Read Docs, Sheets (first sheet), Slides and text files | Read PDFs or other binary files |
| Create Docs, Sheets and Slides (in a "Radiant AI" folder) | Edit documents it did not create |
| Revise or append to Docs it created | |

## Safety notes

- Drive access is the full `drive` scope, so the assistant can *read* everything in your Drive. It can only
  *write* new files and edit its own Docs.
- Anything read from a file is treated as untrusted data: the model is told never to follow instructions
  found inside a file, and it has no tool that could send your files anywhere.
- Spreadsheet values are written as plain text, so formulas in generated data are never executed.
- The Google refresh token is stored encrypted in Redis, keyed to `GOOGLE_CLIENT_SECRET`. It is useless
  without that secret.
- Drive mode only uses models that support tool calling (NVIDIA NIM and Groq). Web search is off in this
  mode. Turn the **Drive** switch off to get web search and every model back.
- To cut access: click the connected Drive button in the sidebar (disconnects and revokes), or remove
  the app at https://myaccount.google.com/permissions.
