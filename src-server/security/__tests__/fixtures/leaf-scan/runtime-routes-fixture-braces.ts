import { createFixtureLeafRoutes } from './fixture-leaf-routes.js';

export function configureRegexRoutes(context: { app: any }): void {
  const marker = /[}]/;
  void marker;
  context.app.route('/api/system', createFixtureLeafRoutes());
}

export function configureStringRoutes(context: { app: any }): void {
  const marker = '}';
  void marker;
  context.app.route('/api/system', createFixtureLeafRoutes());
}

export function configureCommentRoutes(context: { app: any }): void {
  // A closing brace in a comment must not truncate the function body: }
  context.app.route('/api/system', createFixtureLeafRoutes());
}
