import type { RouteObject } from 'react-router';

import App from './App';
import Home from './routes/home';
import Chat from './routes/chat/chat';
import Profile from './routes/profile';
import Settings from './routes/settings/index';
import AppsPage from './routes/apps';
import AppView from './routes/app';
import DiscoverPage from './routes/discover';
import { ProtectedRoute } from './routes/protected-route';
import { PrivacyPage, TermsPage } from './routes/legal-pages';

const routes = [
	{
		path: '/terms',
		Component: TermsPage,
	},
	{
		path: '/privacy',
		Component: PrivacyPage,
	},
	{
		path: '/',
		Component: App,
		children: [
			{
				index: true,
				Component: Home,
			},
			{
				path: 'chat/:chatId',
				Component: Chat,
			},
			{
				path: 'profile',
				element: (
					<ProtectedRoute>
						<Profile />
					</ProtectedRoute>
				),
			},
			{
				path: 'settings',
				element: (
					<ProtectedRoute>
						<Settings />
					</ProtectedRoute>
				),
			},
			{
				path: 'apps',
				element: (
					<ProtectedRoute>
						<AppsPage />
					</ProtectedRoute>
				),
			},
			{
				path: 'app/:id',
				Component: AppView,
			},
			{
				path: 'discover',
				Component: DiscoverPage,
			},
		],
	},
] satisfies RouteObject[];

export { routes };
