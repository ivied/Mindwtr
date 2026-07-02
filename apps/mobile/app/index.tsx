import React from 'react';
import { Redirect } from 'expo-router';

import { MOBILE_HOME_ROUTE } from '@/lib/home-route';

export default function Index() {
    return <Redirect href={MOBILE_HOME_ROUTE} />;
}
