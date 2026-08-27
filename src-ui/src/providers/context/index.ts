/**
 * Default context provider registrations.
 *
 * Import this module once at app startup (e.g. in App.tsx) to register the
 * built-in context providers into contextRegistry.
 */
import { contextRegistry } from '@kontourai/station-sdk';
import { codingFilesContextProvider } from './CodingFilesContextProvider';
import { geolocationContextProvider } from './GeolocationContextProvider';
import { timezoneContextProvider } from './TimezoneContextProvider';

contextRegistry.register(geolocationContextProvider);
contextRegistry.register(timezoneContextProvider);
contextRegistry.register(codingFilesContextProvider);
