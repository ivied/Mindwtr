import { Redirect } from 'expo-router';

// The tab bar intercepts the Menu tab to open the More sheet. Keep this route
// as a redirect so direct links/back navigation cannot show the retired menu.
export default function MenuScreen() {
  return <Redirect href="/inbox" />;
}
