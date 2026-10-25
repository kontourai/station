---
"@kontourai/station-contracts": minor
---

Add the layout contract fields `primary`, `presentation` and `drillIns`, with `parseLayoutPresentationDeclaration` refusing unknown values and unresolvable drill-ins, the `layoutPresentationDeclaration`, `layoutClaimsPrimaryChat`, `layoutPresentsAsStack` and `findPrimaryChatLayout` readers, and the `layout.primaryChat` plugin permission. Built-in Coding declares `primary: 'chat'`, `presentation: 'stack'` and its drill-ins, and any plugin layout declaring the same fields gets the same stack host, Chat centre and ⌘D routing.
