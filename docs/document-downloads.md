# Document downloads in the AI chat

No setup, no accounts, nothing stored on the server.

## How it works

- Ask the chat for a document, spreadsheet or presentation ("draft a cover letter", "make a budget
  spreadsheet", "make a 6-slide pitch"). The model writes it and the chat shows a **file card** with
  download buttons: **Word** and **PDF** for documents, **Excel** for spreadsheets, **PowerPoint** for
  presentations.
- Every reply also has a **Download** button (the arrow under the message): Word, PDF, Markdown or text.
- The page sends the content to `POST /api/export`, which builds the file and returns it as a download.
  The file is never saved.

## Details

- The file tools are only offered when a message looks like a file request (a verb like *draft/create*
  plus a noun like *letter/report/spreadsheet/slides*, or words like *download*, *pdf*, *docx*). Those
  requests use NVIDIA or Groq models (they support tool calling), and web search is off for that message.
  Anything else behaves as before. The Download button on a normal reply works with every model.
- The model is told to use `[placeholders]` instead of inventing names, employers or dates.
- **Limits:** documents up to 60,000 characters; spreadsheets up to 1,000 rows x 50 columns and 5 sheets;
  presentations up to 30 slides with 12 bullets each; 20 exports per minute per visitor.
- **PDF fonts:** PDFs use the standard PDF fonts, which cover Western European text. Other characters are
  simplified (for example the Twi letters ɛ and ɔ become e and o) and emoji are dropped. Word, Excel and
  PowerPoint files keep all characters.
- **Spreadsheet safety:** numbers stay numbers and simple formulas such as `=SUM(B2:B10)` stay live. Any
  other text that starts with `=` (for example `=HYPERLINK(...)`) is stored as plain text, never as a formula.
- This is independent of the Google Drive feature. Drive is optional and still owner-only; this works for
  every visitor.
