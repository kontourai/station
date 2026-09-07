// Test-only tripwire: this lifecycle fixture never grants trusted activation.
export default function createUnapprovedFixtureProvider() {
  throw new Error('Unapproved dependency fixture provider must not activate');
}
