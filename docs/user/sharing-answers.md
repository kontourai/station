# Share an answer

You can send someone a link to one answer from a chat. Anyone who has the link
can read that answer, without signing in, until it expires or you revoke it.

## Create a link

1. Under the answer, open **More answer actions** and choose
   **Answer details**.
2. In the **Provenance** dialog, choose **Share answer**.
3. Station copies the link and says it expires in 7 days. If the browser does
   not allow copying, the link stays on screen so you can copy it yourself.
   Station keeps no second copy of the link, so copy it before you close the
   dialog.

**Share answer** appears only for answers that carry provenance. You cannot
share from the desktop or phone app, or from an address that is not an
ordinary `http` or `https` address; open Station in a browser at a reachable
address first. A browser that is not paired yet is offered pairing first, and
pairing gives that browser full access to your Station.

## What the reader sees

The link opens a page that shows the answer's text as plain paragraphs and a
summary of how it was produced, such as which engine and tools were used.

- Only the answer's text is shared, up to 40 paragraphs of 20,000 characters
  each; the page says how many paragraphs were left out.
- Tool inputs and results, attachments and the rest of the conversation are
  not shared. Tools appear only by name.
- The page also shows the share's label and the conversation and turn
  identifiers.

The page reads the answer from your Station each time it is opened, so the
reader needs to reach the same address you used when you created the link. If
the answer has changed, the conversation is deleted, or you no longer have
access to it, the page says the answer is no longer available. A Station that
runs on your own computer is reachable only by people who can reach that
computer.

## Revoke a link

Open **Settings → Privacy & sharing → Shared answers**. Each link shows its
label (or "Answer from turn …"), whether it is live, revoked or expired, and
when it was created and expires. Choose **Revoke**, then **Confirm**. The link
stops working immediately and its page says it was revoked.

Revoked and expired links stay in the list. You cannot copy a link again,
rename it, or extend it from Settings.

## Limits

- A link lasts 7 days by default. Through the API you can set a label and a
  lifetime of up to 90 days.
- A Station keeps at most 500 links, including revoked and expired ones.
- A hosted Station does not offer answer sharing yet.
- Opening links is rate limited, so a page that is opened very often may ask
  the reader to try again later.

For the API and the security design, see
[answer share permalinks](https://github.com/kontourai/station/blob/main/docs/design/answer-share-permalinks.md).
