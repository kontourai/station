import {
  CUSTOM_APPEARANCE_IMAGE_MAX_BYTES,
  type CustomAppearance,
  type CustomAppearanceDocument,
  type CustomAppearanceVisual,
  createCustomAppearanceThemePack,
  parseCustomAppearanceThemePack,
} from '@kontourai/station-contracts/custom-appearance';
import {
  useCustomAppearanceLibraryMutation,
  useCustomAppearanceLibraryQuery,
} from '@kontourai/station-sdk';
import { Field, Select } from '@kontourai/ui/react';
import { useId, useRef, useState } from 'react';
import { ActionRow } from '../components/ActionRow';
import { Button } from '../components/Button';
import {
  Empty,
  ErrorState,
  FilteredEmpty,
  SkeletonBlock,
} from '../components/state';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import './AppearanceStudio.css';

const failureText = (error: unknown) =>
  error instanceof Error ? error.message : 'Try again.';

export function exportAppearance(appearance: CustomAppearance) {
  const pack = createCustomAppearanceThemePack(appearance);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(pack)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `${appearance.name.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'theme'}.station-theme.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function prepareImage(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw new Error('Choose a PNG, JPEG or WebP image.');
  if (file.size > 20 * 1024 * 1024)
    throw new Error('Choose an image smaller than 20 MB.');
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(new Error('This image could not be opened.'));
      image.src = url;
    });
    const scale = Math.min(
      1,
      1920 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context)
      throw new Error('Image editing is unavailable in this browser.');
    for (let attempt = 0; attempt < 5; attempt++) {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/webp', 0.82);
      const payload = dataUrl.split(',')[1];
      if (
        payload &&
        Math.ceil((payload.length * 3) / 4) <= CUSTOM_APPEARANCE_IMAGE_MAX_BYTES
      )
        return dataUrl;
      canvas.width = Math.max(1, Math.floor(canvas.width * 0.7));
      canvas.height = Math.max(1, Math.floor(canvas.height * 0.7));
    }
    throw new Error('Choose a smaller image.');
  } finally {
    image.src = '';
    URL.revokeObjectURL(url);
  }
}

function RangeField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  onChange(value: number): void;
}) {
  const id = useId();
  return (
    <Field
      label={`${label} · ${Math.round(value * (unit === '%' ? 100 : 1))}${unit}`}
      htmlFor={id}
    >
      <input
        id={id}
        className="appearance-studio__range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </Field>
  );
}

export function AppearanceVisualControls({
  visual,
  onChange,
  onPreparing,
}: {
  onPreparing?(preparing: boolean): void;
  visual: CustomAppearanceVisual | undefined;
  onChange(visual: CustomAppearanceVisual): void;
}) {
  const scope = useHostRequestAuthorityScope();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const fitId = useId();
  const positionId = useId();
  const background = visual?.background;
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setLoading(true);
    onPreparing?.(true);
    try {
      const dataUrl = await prepareImage(file);
      if (!scope?.isCurrent()) return;
      onChange({
        ...visual,
        background: { dataUrl, size: 'cover', position: 'center', dim: 0.35 },
      });
    } catch (error) {
      setError(failureText(error));
    } finally {
      setLoading(false);
      onPreparing?.(false);
    }
  };
  return (
    <fieldset
      className="appearance-studio__visual content-stack"
      disabled={loading}
    >
      <legend>Visual style</legend>
      <fieldset
        className="appearance-studio__upload content-stack"
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (!loading) void upload(event.dataTransfer.files[0]);
        }}
      >
        <legend>Background</legend>
        {background && (
          <img
            className="appearance-studio__image"
            src={background.dataUrl}
            alt="Your background"
          />
        )}
        <p className="appearance-custom__note">
          Choose or drop a background image. It stays inside your theme pack.
        </p>
        <input
          ref={imageInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="Background image file"
          hidden
          onChange={(event) => {
            void upload(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <ActionRow
          overflowLabel="More background actions"
          primary={
            <Button
              pending={loading}
              onClick={() => imageInput.current?.click()}
            >
              {background ? 'Replace image' : 'Choose image'}
            </Button>
          }
          secondary={
            background ? (
              <Button
                disabled={loading}
                onClick={() => onChange({ ...visual, background: undefined })}
              >
                Remove image
              </Button>
            ) : undefined
          }
        />
      </fieldset>
      {error && (
        <ErrorState
          variant="compact"
          title="Image did not load"
          description={error}
          action={
            <Button onClick={() => imageInput.current?.click()}>
              Choose image
            </Button>
          }
        />
      )}
      {background && (
        <div className="appearance-studio__fields">
          <Field label="Image size" htmlFor={fitId}>
            <Select
              id={fitId}
              value={background.size}
              onChange={(event) => {
                const size = event.target.value;
                if (size === 'cover' || size === 'contain' || size === 'tile')
                  onChange({ ...visual, background: { ...background, size } });
              }}
              options={[
                { value: 'cover', label: 'Fill' },
                { value: 'contain', label: 'Fit' },
                { value: 'tile', label: 'Tile' },
              ]}
            />
          </Field>
          <Field label="Image position" htmlFor={positionId}>
            <Select
              id={positionId}
              value={background.position}
              onChange={(event) => {
                const position = event.target.value;
                if (
                  position === 'center' ||
                  position === 'top' ||
                  position === 'bottom' ||
                  position === 'left' ||
                  position === 'right'
                )
                  onChange({
                    ...visual,
                    background: { ...background, position },
                  });
              }}
              options={['center', 'top', 'bottom', 'left', 'right'].map(
                (value) => ({
                  value,
                  label: value[0]!.toUpperCase() + value.slice(1),
                }),
              )}
            />
          </Field>
          <RangeField
            label="Image dimming"
            value={background.dim}
            min={0}
            max={1}
            step={0.05}
            unit="%"
            onChange={(dim) =>
              onChange({ ...visual, background: { ...background, dim } })
            }
          />
        </div>
      )}
      <div className="appearance-studio__fields">
        <RangeField
          label="Panel opacity"
          value={visual?.panelOpacity ?? 1}
          min={0.5}
          max={1}
          step={0.05}
          unit="%"
          onChange={(panelOpacity) => onChange({ ...visual, panelOpacity })}
        />
        <RangeField
          label="Corner rounding"
          value={visual?.radius ?? 14}
          min={0}
          max={24}
          unit="px"
          onChange={(radius) => onChange({ ...visual, radius })}
        />
        <RangeField
          label="Text size"
          value={visual?.fontSize ?? 14}
          min={12}
          max={20}
          unit="px"
          onChange={(fontSize) => onChange({ ...visual, fontSize })}
        />
      </div>
    </fieldset>
  );
}

function ThemeThumbnail({ appearance }: { appearance: CustomAppearance }) {
  const palette = appearance.palette.dark ?? appearance.palette.light;
  return (
    <div
      className="appearance-studio__thumbnail"
      aria-hidden="true"
      style={{
        backgroundColor: palette?.roles?.['--k-bg'],
        color: palette?.roles?.['--k-text'],
      }}
    >
      {appearance.visual?.background && (
        <img src={appearance.visual.background.dataUrl} alt="" />
      )}
      <div
        className="appearance-studio__thumbnail-panel"
        style={{
          backgroundColor: palette?.roles?.['--k-panel'],
          borderRadius: appearance.visual?.radius,
        }}
      >
        <span
          className="appearance-studio__thumbnail-line"
          style={{ backgroundColor: palette?.accent }}
        />
        <span className="appearance-studio__thumbnail-line" />
        <span className="appearance-studio__thumbnail-line" />
      </div>
    </div>
  );
}

export function AppearanceLibrary({
  document,
  disabled,
  onEdit,
  onApply,
}: {
  document: CustomAppearanceDocument;
  disabled: boolean;
  onEdit(
    appearance: CustomAppearance | null,
    imported?: boolean,
    savedThemeId?: string,
  ): void;
  onApply(appearance: CustomAppearance): void;
}) {
  const scope = useHostRequestAuthorityScope();
  const query = useCustomAppearanceLibraryQuery(scope ?? undefined);
  const mutation = useCustomAppearanceLibraryMutation(scope ?? undefined);
  const [error, setError] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const importPack = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      if (file.size > 2 * 1024 * 1024)
        throw new Error('Choose a theme pack smaller than 2 MB.');
      const result = parseCustomAppearanceThemePack(await file.text());
      if (!result.ok)
        throw new Error(result.violations.map((v) => v.message).join(' '));
      if (scope?.isCurrent()) onEdit(result.value.appearance, true);
    } catch (error) {
      setError(failureText(error));
    }
  };
  const themes =
    query.data?.themes.filter((theme) => !favoritesOnly || theme.favorite) ??
    [];
  return (
    <section
      className="appearance-studio content-stack"
      aria-label="Theme library"
    >
      <h3>Theme library</h3>
      <ActionRow
        overflowLabel="More theme library actions"
        primary={<Button onClick={() => onEdit(null)}>New theme</Button>}
        secondary={
          <Button onClick={() => importInput.current?.click()}>
            Import theme pack
          </Button>
        }
        overflow={
          document.active
            ? [
                {
                  key: 'edit-current',
                  label: 'Edit current theme',
                  onSelect: () => onEdit(document.active),
                },
              ]
            : []
        }
      />
      <input
        ref={importInput}
        type="file"
        accept="application/json,.json"
        hidden
        aria-label="Theme pack file"
        onChange={(event) => {
          void importPack(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      {error && (
        <ErrorState
          variant="compact"
          title="Theme pack did not open"
          description={error}
          action={
            <Button onClick={() => importInput.current?.click()}>
              Choose theme pack
            </Button>
          }
        />
      )}
      {query.isPending && !query.data ? (
        <SkeletonBlock label="Loading theme library" />
      ) : query.isError ? (
        <ErrorState
          variant="compact"
          title="Theme library did not load"
          action={<Button onClick={() => void query.refetch()}>Retry</Button>}
        />
      ) : null}
      {query.data && (
        <>
          <label className="appearance-studio__filter">
            <input
              type="checkbox"
              checked={favoritesOnly}
              onChange={(event) => setFavoritesOnly(event.target.checked)}
            />
            Favorites only
          </label>
          {themes.length === 0 ? (
            favoritesOnly ? (
              <FilteredEmpty
                query="favorites"
                title="Favorites will appear here"
                description="Favorite a saved theme to find it here."
                onClear={() => setFavoritesOnly(false)}
              />
            ) : (
              <Empty
                label="Your themes will appear here"
                description="Save a theme to restore it later."
              />
            )
          ) : (
            <div className="appearance-studio__library">
              {themes.map((theme) => (
                <article
                  className="appearance-studio__card content-stack"
                  key={theme.id}
                >
                  <ThemeThumbnail appearance={theme.appearance} />
                  <h4>
                    {theme.name}
                    {theme.favorite && (
                      <span className="appearance-custom__note">
                        {' '}
                        · Favorite
                      </span>
                    )}
                  </h4>
                  <ActionRow
                    overflowLabel={`More actions for ${theme.name}`}
                    primary={
                      <Button
                        variant="primary"
                        disabled={disabled}
                        onClick={() => onApply(theme.appearance)}
                      >
                        Apply
                      </Button>
                    }
                    secondary={
                      <Button
                        onClick={() =>
                          onEdit(
                            { ...theme.appearance, name: theme.name },
                            false,
                            theme.id,
                          )
                        }
                      >
                        Edit
                      </Button>
                    }
                    overflow={[
                      {
                        key: 'favorite',
                        label: 'Favorite',
                        checked: theme.favorite,
                        disabled: mutation.isPending,
                        onSelect: () =>
                          mutation.mutate({
                            kind: 'update',
                            revision: query.data!.revision,
                            id: theme.id,
                            favorite: !theme.favorite,
                          }),
                      },
                      {
                        key: 'duplicate',
                        label: 'Duplicate',
                        disabled: mutation.isPending,
                        onSelect: () =>
                          mutation.mutate({
                            kind: 'save',
                            revision: query.data!.revision,
                            appearance: {
                              ...theme.appearance,
                              name: `${theme.name.slice(0, 73)} copy`,
                            },
                            favorite: false,
                          }),
                      },
                      {
                        key: 'export',
                        label: 'Export theme pack',
                        onSelect: () => exportAppearance(theme.appearance),
                      },
                      {
                        key: 'delete',
                        label: 'Delete',
                        tone: 'danger',
                        disabled: mutation.isPending,
                        onSelect: () =>
                          mutation.mutate({
                            kind: 'remove',
                            revision: query.data!.revision,
                            id: theme.id,
                          }),
                      },
                    ]}
                  />
                </article>
              ))}
            </div>
          )}
        </>
      )}
      {mutation.isError && (
        <ErrorState
          variant="compact"
          title="Theme library did not save"
          description={failureText(mutation.error)}
          action={
            <Button
              onClick={() => {
                mutation.reset();
                void query.refetch();
              }}
            >
              Reload library
            </Button>
          }
        />
      )}
    </section>
  );
}

export function SaveAppearanceToLibrary({
  appearance,
  disabled,
  savedThemeId,
  onSaved,
}: {
  appearance: CustomAppearance;
  disabled: boolean;
  savedThemeId?: string;
  onSaved(id: string): void;
}) {
  const scope = useHostRequestAuthorityScope();
  const query = useCustomAppearanceLibraryQuery(scope ?? undefined);
  const mutation = useCustomAppearanceLibraryMutation(scope ?? undefined);
  const [savedAppearance, setSavedAppearance] = useState<string | null>(null);
  return (
    <div className="content-stack">
      {query.isPending && !query.data && (
        <SkeletonBlock label="Loading theme library" />
      )}
      {query.isError && (
        <ErrorState
          variant="compact"
          title="Theme library did not load"
          action={<Button onClick={() => void query.refetch()}>Retry</Button>}
        />
      )}
      <ActionRow
        overflowLabel="More draft actions"
        primary={
          <Button
            disabled={disabled || !query.data || query.isError}
            pending={mutation.isPending}
            onClick={() => {
              if (query.data)
                mutation.mutate(
                  {
                    kind: 'save',
                    revision: query.data.revision,
                    appearance,
                    id: savedThemeId,
                  },
                  {
                    onSuccess: (next) => {
                      if (!scope?.isCurrent()) return;
                      const canonical =
                        createCustomAppearanceThemePack(appearance).appearance;
                      const saved = next.themes.find(
                        (theme) =>
                          JSON.stringify(theme.appearance) ===
                          JSON.stringify(canonical),
                      );
                      if (saved) {
                        onSaved(saved.id);
                        setSavedAppearance(JSON.stringify(appearance));
                      }
                    },
                  },
                );
            }}
          >
            Save to library
          </Button>
        }
        secondary={
          <Button
            disabled={disabled}
            onClick={() => exportAppearance(appearance)}
          >
            Export theme pack
          </Button>
        }
      />
      {savedAppearance === JSON.stringify(appearance) && (
        <p role="status" className="appearance-custom__note">
          Saved to your theme library.
        </p>
      )}
      {mutation.isError && (
        <ErrorState
          variant="compact"
          title="Theme did not save"
          description={failureText(mutation.error)}
          action={
            <Button
              onClick={() => {
                mutation.reset();
                void query.refetch();
              }}
            >
              Reload library
            </Button>
          }
        />
      )}
    </div>
  );
}
