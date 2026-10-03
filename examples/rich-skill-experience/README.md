# Isolated Skill experience pane

This independent example adds a declared Workspace Pane to the original interview
Skill in [visual-skill-experience](../visual-skill-experience). Its portable Skill
and inert definition validate through the public author build. It uses no core
component allowlist or server module.

Run `station plugin build` in this folder with the CLI built from this revision,
then install and activate it through the Registry. Grant `agents.invoke` when
reviewing the package. In a Project chat, select its experience, review the idea
input and explicitly send. Choose the rich presentation if its declared pane is
available. Ordinary guided/chat presentation remains available when it is not.

The pane renders DOM in the existing isolated plugin document. Its shell
registration is inert; the example does not depend on React or authenticated SDK
hooks inside the frame. The host supplies only the public
`createSkillExperiencePaneHost` transport producer and the outer frame origin.
Neither carries credentials. The transport reads the immutable invocation view
and bounded canonical pending questions, answers the exact request event, and
stages an explicitly selected next experience in Station’s composer. Sending the
next stage remains a user action. It invents no progress or output state.

**Prepare another round** stages the same experience with its original inputs.
This is an example-added convenience, not a promised output of the Skill. Review
the prepared composer and explicitly send to begin that round. Declared links to
other experiences use the same preparation path.

Refresh questions after the engine asks a canonical input question. Text/choice
answers return through the existing `respondToRequest` command. Secret questions,
ordinary approval requests and engines that ask in chat keep Station’s canonical
controls. The source package is checked again before every effect. The bundle
transfer also checks the exact installed identity and current grant.

Building and controlled host tests establish author/runtime integration only.
Live provider, browser, native-device and released-package qualification are
separate evidence; this README does not assert them.
