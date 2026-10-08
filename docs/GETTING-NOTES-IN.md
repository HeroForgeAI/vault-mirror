# Getting your notes into Markdown

vault-mirror reads Markdown notes: plain text files whose names end in `.md`. A lot of what you know lives somewhere else, in emails, PDFs, Word files or Notion. This page is about turning those into notes your AI can find.

Two things to know first.

- **vault-mirror does none of this converting.** It only reads the notes in your vault and never writes there. The converting is done by you, by your AI, or by another tool. The new notes are saved into the vault by whoever does the converting, and the next `vault-mirror sync` picks them up.
- **You do not have to convert everything.** Start with the ten things you look up most. A small vault of useful notes beats a large one nobody checked.

## Before you start: what to keep out

A search hands passages from your notes to your AI, and your AI's service receives them, the same as when you paste a note into a chat. So decide what goes in before you convert it.

- **Keep patient information out.** Do not convert patient emails, charts, letters or reports into a vault this tool is set up on. vault-mirror makes no HIPAA claim.
- **Keep other people's private details out** unless you would be content to paste them into a chat: health, money, legal matters, staff records.
- **Keep passwords, keys and account numbers out.** The tool flags passages that look like a key, but it cannot catch everything.

If one folder in a vault must stay out of the index, name it under `exclude` in the [settings](CONFIGURATION.md), or put `index: false` in a note's properties.

## Emails

One note per whole conversation works best, not one note per message. A conversation split across twelve notes gives twelve half-answers. One note with the whole thread gives the full story, and the date and the people at the top let you find it by who and when.

If your AI can read your mail, ask it. If it cannot, paste the thread into the chat and ask the same thing. An example to adapt:

> Find the email thread about the roof repair quote. Write it as one Markdown note in my vault, in the folder `Emails`. At the top put the subject as the title, then the date of the first and last message, and the names of the people in it. Under that, write each message in order with its sender and date, in full. Leave out signatures and repeated quoted text. Do not change any wording.

What to check afterwards: open the note and read the top. The dates and names should be right, and the last message should be the real last one.

## PDFs, Word and other documents

Use a converter that is built for this. We suggest [MarkItDown](https://github.com/microsoft/markitdown), from Microsoft. It is free and open source (MIT license), and it runs on your computer. Its own README lists what it converts: PDF, PowerPoint, Word, Excel, images, audio, HTML, text formats such as CSV, JSON and XML, ZIP files, YouTube URLs and EPubs. It needs Python 3.10 or newer, and your AI can install it for you.

**Why not let your AI write its own PDF reader?** A PDF stores where each letter sits on the page, not the order the words are read in. Home-made code tends to scramble columns, lose tables and drop headings, and it does so quietly, so the note looks fine until you need the part that went missing. A tool many people already use has met those cases.

An example to adapt:

> Install Microsoft's MarkItDown if it is not installed (https://github.com/microsoft/markitdown). Convert every PDF and Word file in `~/Documents/Manuals` to Markdown with it. Save each one as its own note in my vault, in the folder `Manuals`, with the same name as the original. At the top of each note add one line with a link to the original file and the date it was converted. Do not write your own converter. Tell me which files came out empty or garbled.

Three habits that pay off:

- **Keep a link to the original at the top of each note.** The note is a copy for finding things. When a figure or a table matters, you open the original and check.
- **Keep the originals.** Converting is never perfect. Tables and page layouts suffer most.
- **Watch for scanned pages.** A scanned PDF is a picture of a page, and a converter may bring back little or no text from it. Ask your AI to list the notes that came out nearly empty.

MarkItDown's README says its output is meant for text tools and AI, and may not be the best choice when a person needs a faithful copy of the document. That is the right trade here: your AI needs the words and the headings.

## Notion

vault-mirror cannot read Notion. Notion pages live in Notion's service, not as files on your computer, so they have to be brought out as Markdown first. There are two ways.

- **Notion's own export.** On a page, open the `•••` menu at the top right, choose **Export**, pick **Markdown & CSV**, and turn on **Include subpages** if you want the pages under it. Pages come out as Markdown files, and databases come out as CSV files. Unzip what you download into a folder in your vault. A whole workspace can be exported from Notion's settings.
- **Notion's MCP connector.** If your AI is connected to Notion through Notion's MCP server, it can read your pages, and you can ask it to save them as Markdown notes in your vault. That connector can also change content in Notion, so say plainly that you want pages read and nothing in Notion changed.

An example for the second way:

> Read the pages under "Operations handbook" in Notion. Save each page as one Markdown note in my vault, in the folder `Notion/Operations handbook`, with the page title as the file name. At the top of each note add the link to the Notion page and today's date. Do not change anything in Notion.

**Either way it is a copy, and it goes stale.** When a page changes in Notion, the note in your vault does not. Bring the pages out again on whatever schedule suits how often they change: once a month for a handbook, once a week for something busy. After each time, run `vault-mirror sync`. It reads only the notes that changed.

The CSV files from a Notion database are not Markdown, so vault-mirror leaves them alone. If a database matters, ask your AI to turn it into a Markdown note with a table, or one note per row.

## Other files that sit in a vault

A vault often holds more than notes: pictures, PDFs, `.canvas` boards, spreadsheets. **vault-mirror reads `.md` files only.** Everything else is counted and left alone. A sync says so in one line:

```text
Checked 176 notes: 176 new, 0 changed, 0 removed, 0 left out. 144 other files (images, PDFs and the like) are not notes and were not read.
```

So a PDF dropped into your vault is not searchable until there is a Markdown note of it beside it. The file itself is safe where it is. The tool does not open it, move it or change it.

## After the notes are in

1. Run `vault-mirror sync`, or say "Sync my vault" to your AI.
2. Run `vault-mirror status` and look for `In step: yes`.
3. Ask a question that one of the new notes answers, and check that the answer names that note.

## The promise does not change

vault-mirror only reads your notes. It never edits, moves or deletes anything in your vault, and it never creates a note. Every new note on this page is written by you, by your AI or by a converter. The tool only reads what they leave there.

Back to the [README](../README.md).
