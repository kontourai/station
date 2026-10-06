# Visual skill experience authoring example

This package contains a portable interview Skill and a handwritten Station
experience definition. It demonstrates author validation, not a rendered or
installed visual workflow. The Skill is original example material; it does not
redistribute a third-party collection.

With a Station CLI built from this source revision on Node 24, run
`station plugin build` from this directory. The author build validates the
definition, its manifest reference, and the exact bundled Skill bytes before
reporting that no JavaScript bundle is needed. No Station home, running server,
model connection, or resource grants are required for that validation.

The experience requests an idea and conversation/artifact-output capabilities.
It describes adaptive question rounds in guided or alongside presentation.
The optional decision summary is explicitly Station-added. These descriptions
do not grant tools, create a session, guarantee outputs, or execute the Skill.

If you change `skills/stress-test-idea/SKILL.md`, review the experience and
update its `sha256` to the SHA-256 of the file bytes. Package identity/version
comes from `plugin.json`. Another Agent Plugins client can ignore the Station
namespace and consume the portable Skill.

See the [contract and compatibility decisions](../../docs/reference/skill-experiences.md).
