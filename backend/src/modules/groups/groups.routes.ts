import { Router } from 'express';
import { authMiddleware, driverMiddleware } from '../../middleware/auth.middleware';
import { GroupsController } from './groups.controller';

const router = Router();

// Public invitation preview: the token itself is the bearer credential. It
// returns group name / inviter first name only, never member PII.
router.get('/invitations/token/:token', GroupsController.invitationPreview);

router.use(authMiddleware);

// Friends (selected contacts only — no public directory search).
router.get('/friends', GroupsController.friends);
router.post('/friends/match', GroupsController.matchContacts);
router.post('/friends/requests', GroupsController.requestFriend);
router.post('/friends/requests/:friendshipId/respond', GroupsController.respondFriend);
router.delete('/friends/:userId', GroupsController.removeFriend);

// Invitation acceptance / decline.
router.get('/invitations/incoming', GroupsController.incomingInvitations);
router.post('/invitations/token/:token/accept', GroupsController.joinByToken);
router.post('/invitations/:invitationId/accept', GroupsController.acceptInvitation);
router.post('/invitations/:invitationId/decline', GroupsController.declineInvitation);

// Driver-facing multi-stop operations. These intentionally live under the
// same router so every group authorization rule is in one place.
router.get('/rides/:rideId/driver', driverMiddleware, GroupsController.driverRideView);
router.post(
  '/rides/:rideId/pickups/:participantId',
  driverMiddleware,
  GroupsController.confirmPassengerPickup,
);
router.post(
  '/rides/:rideId/no-show/:participantId',
  driverMiddleware,
  GroupsController.markPassengerNoShow,
);

// Groups.
router.get('/', GroupsController.list);
router.post('/', GroupsController.create);
router.get('/:id', GroupsController.detail);
router.patch('/:id', GroupsController.rename);
router.post('/:id/leave', GroupsController.leave);
router.post('/:id/cancel', GroupsController.cancel);
router.delete('/:id/members/:userId', GroupsController.removeMember);
router.post('/:id/pickup', GroupsController.setPickup);
router.post('/:id/destination', GroupsController.setDestination);
router.post('/:id/quote/preview', GroupsController.previewQuote);
router.post('/:id/quote', GroupsController.quote);
router.get('/:id/messages', GroupsController.messages);
router.post('/:id/messages', GroupsController.sendMessage);
router.post('/:id/read', GroupsController.markRead);
router.post('/:id/invitations', GroupsController.inviteFriend);
router.post('/:id/invitations/contact', GroupsController.inviteContact);
router.delete('/:id/invitations/:invitationId', GroupsController.cancelInvitation);
router.get('/:id/payments', GroupsController.payments);
router.post('/:id/payments/confirm', GroupsController.paymentConfirm);
router.post('/:id/request', GroupsController.requestRide);

export default router;
