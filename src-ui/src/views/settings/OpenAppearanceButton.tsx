import { Button } from '../../components/Button';
import { useNavigation } from '../../contexts/NavigationContext';

/**
 * Color theme, flavor and accent moved to the Appearance page. Settings keeps
 * a row for `theme` and `accent-color` that leads there, so its own search,
 * the palette's Settings targets and recorded `highlight=` links still land
 * on something that answers them.
 */
export function OpenAppearanceButton({ forRow }: { forRow: string }) {
  const { navigate } = useNavigation();
  // Two of these sit in one section; the name says which row each answers,
  // and starts with the visible words so speech input still finds it.
  return (
    <Button
      size="sm"
      aria-label={`Open Appearance for ${forRow}`}
      onClick={() => navigate('/appearance')}
    >
      Open Appearance
    </Button>
  );
}
