import { Hono } from 'hono';
import { ContactController } from '../controllers/contact/controller';
import { adaptController } from '../honoAdapter';
import { AppEnv } from '../../types/appenv';
import { AuthConfig, setAuthLevel } from '../../middleware/auth/routeAuth';

export function setupContactRoutes(app: Hono<AppEnv>): void {
	const contactRouter = new Hono<AppEnv>();

	// Public contact endpoint
	contactRouter.post(
		'/',
		setAuthLevel(AuthConfig.public),
		adaptController(ContactController, ContactController.submitContactForm),
	);

	app.route('/api/contact', contactRouter);
}
