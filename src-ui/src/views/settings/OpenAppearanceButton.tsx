import { Button } from '../../components/Button';
import { useNavigation } from '../../contexts/NavigationContext';

/**
 * Color theme, flavor and accent moved to the Appearance page. Settings keeps
 * a row for `theme` and `accent-color` that leads there, so its own search,
 * the palette's Settings targets and recorded `highlight=` links still land
 * on something that answers them.
 */
export function OpenAppearanceButton() {
  const { navigate } = useNavigation();
  return (
    <Button size="sm" onClick={() => navigate('/appearance')}>
      Open Appearance
    </Button>
  );
}
