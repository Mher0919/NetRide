import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../../middleware/auth.middleware';
import { GroupService, GroupError } from './group.service';
import { GroupRideService, GroupRideError } from './group-ride.service';
import { GroupPaymentsService } from './group-payments.service';
import { FriendsService } from './friends.service';

const LatLng = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const CreateGroupSchema = z.object({
  name: z.string().min(1).max(80),
  memberIds: z.array(z.string().uuid()).max(4).optional().default([]),
});

const RenameSchema = z.object({ name: z.string().min(1).max(80) });

const PickupSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  address: z.string().max(500).optional(),
  placeId: z.string().max(300).nullable().optional(),
  sameAsHost: z.boolean().optional().default(false),
}).refine((v) => v.sameAsHost === true || (typeof v.lat === 'number' && typeof v.lng === 'number'), {
  message: 'Provide a pickup location or choose the host pickup',
});

const DestinationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().min(1).max(500),
  placeId: z.string().max(300).nullable().optional(),
});

const QuoteSchema = z.object({
  splitMethod: z.enum(['HOST_PAYS', 'EQUAL', 'DISTANCE', 'CUSTOM']),
  promoCode: z.string().max(64).nullable().optional(),
  vehicleCategory: z.enum(['CORE', 'PREMIUM']).optional(),
  customShares: z.record(z.string().uuid(), z.number().int().min(0)).optional(),
});

const MessageSchema = z.object({ message: z.string().min(1).max(2000) });

const InviteFriendSchema = z.object({ userId: z.string().uuid() });
const InviteContactSchema = z.object({
  phone: z.string().min(7).max(32),
  name: z.string().max(120).optional(),
  message: z.string().max(300).optional(),
});

const PaymentSchema = z.object({ useCredits: z.boolean().optional().default(false) });

const FriendRequestSchema = z.object({
  userId: z.string().uuid().optional(),
  phone: z.string().min(7).max(32).optional(),
}).refine((v) => !!v.userId || !!v.phone, { message: 'Provide a user or phone number' });

const FriendRespondSchema = z.object({ accept: z.boolean() });

const ContactsSchema = z.object({
  contacts: z.array(z.object({
    phone: z.string().min(7).max(32),
    name: z.string().max(120).optional(),
  })).min(1).max(50),
});

function fail(res: Response, err: any): Response {
  if (err instanceof GroupError || err instanceof GroupRideError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  if (err?.name === 'GroupRouteError') {
    const status = err.code === 'NO_DESTINATION' || err.code === 'NO_PICKUPS' ? 409 : 502;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  if (err?.code === 'GROUP_FULL' || String(err?.message ?? '').includes('GROUP_FULL')) {
    return res.status(409).json({ error: 'This group is full', code: 'GROUP_FULL' });
  }
  if (err?.code === '23505') {
    return res.status(409).json({
      error: 'That request conflicts with an existing invitation or booking.',
      code: 'CONFLICT',
    });
  }
  if (err?.name === 'ZodError') {
    return res.status(400).json({ error: 'Invalid request', details: err.issues });
  }
  console.error('[GROUPS] unhandled error:', err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

function userId(req: AuthRequest): string {
  return req.user!.id;
}

export class GroupsController {
  static async list(req: AuthRequest, res: Response) {
    try {
      const groups = await GroupService.listGroups(userId(req));
      res.json({ groups });
    } catch (err) {
      fail(res, err);
    }
  }

  static async create(req: AuthRequest, res: Response) {
    try {
      const body = CreateGroupSchema.parse(req.body);
      const group = await GroupService.createGroup(userId(req), body);
      res.status(201).json({ group });
    } catch (err) {
      fail(res, err);
    }
  }

  static async detail(req: AuthRequest, res: Response) {
    try {
      const group = await GroupService.getGroup(req.params.id, userId(req));
      res.json({ group });
    } catch (err) {
      fail(res, err);
    }
  }

  static async rename(req: AuthRequest, res: Response) {
    try {
      const body = RenameSchema.parse(req.body);
      const group = await GroupService.rename(req.params.id, userId(req), body.name);
      res.json({ group });
    } catch (err) {
      fail(res, err);
    }
  }

  static async removeMember(req: AuthRequest, res: Response) {
    try {
      if (!FriendsService.isUuid(req.params.userId)) {
        return res.status(400).json({ error: 'Invalid participant', code: 'INVALID_MEMBER' });
      }
      const group = await GroupService.removeMember(req.params.id, userId(req), req.params.userId);
      res.json({ group });
    } catch (err) {
      fail(res, err);
    }
  }

  static async leave(req: AuthRequest, res: Response) {
    try {
      const result = await GroupService.leaveGroup(req.params.id, userId(req));
      res.json(result);
    } catch (err) {
      fail(res, err);
    }
  }

  static async setPickup(req: AuthRequest, res: Response) {
    try {
      const body = PickupSchema.parse(req.body);
      const group = await GroupService.setPickup(req.params.id, userId(req), body);
      res.json({ group });
    } catch (err) {
      fail(res, err);
    }
  }

  static async setDestination(req: AuthRequest, res: Response) {
    try {
      const body = DestinationSchema.parse(req.body);
      const group = await GroupService.setDestination(req.params.id, userId(req), body);
      res.json({ group });
    } catch (err) {
      fail(res, err);
    }
  }

  static async previewQuote(req: AuthRequest, res: Response) {
    try {
      const body = z.object({ promoCode: z.string().max(64).nullable().optional() }).parse(req.body ?? {});
      const preview = await GroupService.previewQuote(req.params.id, userId(req), body);
      res.json(preview);
    } catch (err) {
      fail(res, err);
    }
  }

  static async quote(req: AuthRequest, res: Response) {
    try {
      const body = QuoteSchema.parse(req.body);
      const group = await GroupService.createQuote(req.params.id, userId(req), body);
      res.status(201).json({ group });
    } catch (err) {
      fail(res, err);
    }
  }

  static async cancel(req: AuthRequest, res: Response) {
    try {
      await GroupService.cancelGroup(req.params.id, userId(req));
      const group = await GroupService.getGroup(req.params.id, userId(req));
      res.json({ group });
    } catch (err) {
      fail(res, err);
    }
  }

  static async messages(req: AuthRequest, res: Response) {
    try {
      const before = typeof req.query.before === 'string' ? req.query.before : null;
      const limit = Number(req.query.limit ?? 50);
      const result = await GroupService.listMessages(req.params.id, userId(req), before, limit);
      res.json(result);
    } catch (err) {
      fail(res, err);
    }
  }

  static async markRead(req: AuthRequest, res: Response) {
    try {
      await GroupService.markRead(req.params.id, userId(req));
      res.json({ read: true });
    } catch (err) {
      fail(res, err);
    }
  }

  static async sendMessage(req: AuthRequest, res: Response) {
    try {
      const body = MessageSchema.parse(req.body);
      const message = await GroupService.sendMessage(req.params.id, userId(req), body.message);
      res.status(201).json({ message });
    } catch (err) {
      fail(res, err);
    }
  }

  static async inviteFriend(req: AuthRequest, res: Response) {
    try {
      const body = InviteFriendSchema.parse(req.body);
      const invitation = await GroupService.inviteFriend(req.params.id, userId(req), body.userId);
      res.status(201).json(invitation);
    } catch (err) {
      fail(res, err);
    }
  }

  static async inviteContact(req: AuthRequest, res: Response) {
    try {
      const body = InviteContactSchema.parse(req.body);
      const result = await GroupService.inviteContact(req.params.id, userId(req), body);
      res.status(201).json(result);
    } catch (err) {
      fail(res, err);
    }
  }

  static async cancelInvitation(req: AuthRequest, res: Response) {
    try {
      if (!FriendsService.isUuid(req.params.invitationId)) {
        return res.status(400).json({ error: 'Invalid invitation', code: 'INVALID_INVITATION' });
      }
      await GroupService.cancelInvitation(req.params.id, userId(req), req.params.invitationId);
      res.json({ cancelled: true });
    } catch (err) {
      fail(res, err);
    }
  }

  static async acceptInvitation(req: AuthRequest, res: Response) {
    try {
      if (!FriendsService.isUuid(req.params.invitationId)) {
        return res.status(400).json({ error: 'Invalid invitation', code: 'INVALID_INVITATION' });
      }
      const result = await GroupService.acceptInvitationById(userId(req), req.params.invitationId);
      const group = await GroupService.getGroup(result.groupId, userId(req));
      res.json({ groupId: result.groupId, group });
    } catch (err) {
      fail(res, err);
    }
  }

  static async declineInvitation(req: AuthRequest, res: Response) {
    try {
      if (!FriendsService.isUuid(req.params.invitationId)) {
        return res.status(400).json({ error: 'Invalid invitation', code: 'INVALID_INVITATION' });
      }
      await GroupService.declineInvitation(userId(req), req.params.invitationId);
      res.json({ declined: true });
    } catch (err) {
      fail(res, err);
    }
  }

  static async incomingInvitations(req: AuthRequest, res: Response) {
    try {
      const invitations = await GroupService.listIncomingInvitations(userId(req));
      res.json({ invitations });
    } catch (err) {
      fail(res, err);
    }
  }

  static async invitationPreview(req: AuthRequest, res: Response) {
    try {
      const preview = await GroupService.invitePreview(req.params.token);
      res.json(preview);
    } catch (err) {
      fail(res, err);
    }
  }

  static async joinByToken(req: AuthRequest, res: Response) {
    try {
      const result = await GroupService.acceptInvitationByToken(userId(req), req.params.token);
      const group = await GroupService.getGroup(result.groupId, userId(req));
      res.json({ groupId: result.groupId, group });
    } catch (err) {
      fail(res, err);
    }
  }

  static async paymentConfirm(req: AuthRequest, res: Response) {
    try {
      const body = PaymentSchema.parse(req.body);
      await GroupPaymentsService.confirmPayment({
        groupId: req.params.id,
        userId: userId(req),
        useCredits: body.useCredits,
      });
      const group = await GroupService.getGroup(req.params.id, userId(req));
      res.json({ group });
    } catch (err) {
      fail(res, err);
    }
  }

  static async payments(req: AuthRequest, res: Response) {
    try {
      const group = await GroupService.getGroup(req.params.id, userId(req));
      res.json({
        payments: group.payments.map((p) => ({
          participantId: p.participantId,
          amountCents: group.isHost || p.participantId === userId(req) ? p.amountCents : 0,
          required: p.required,
          status: p.status,
          method: p.method,
          creditCents: p.creditCents,
          cardCents: p.cardCents,
          failureReason: p.participantId === userId(req) ? p.failureReason : undefined,
        })),
        myShare: group.myShare,
        allPaid: group.canRequest,
      });
    } catch (err) {
      fail(res, err);
    }
  }

  static async requestRide(req: AuthRequest, res: Response) {
    try {
      const result = await GroupRideService.requestRide(req.params.id, userId(req));
      res.status(result.idempotent ? 200 : 201).json(result);
    } catch (err) {
      fail(res, err);
    }
  }

  static async driverRideView(req: AuthRequest, res: Response) {
    try {
      if (!FriendsService.isUuid(req.params.rideId)) {
        return res.status(400).json({ error: 'Invalid ride', code: 'INVALID_RIDE' });
      }
      const view = await GroupRideService.getDriverRideView(req.params.rideId, userId(req));
      res.json(view);
    } catch (err) {
      fail(res, err);
    }
  }

  static async confirmPassengerPickup(req: AuthRequest, res: Response) {
    try {
      if (!FriendsService.isUuid(req.params.rideId) || !FriendsService.isUuid(req.params.participantId)) {
        return res.status(400).json({ error: 'Invalid pickup request', code: 'INVALID_PICKUP' });
      }
      const result = await GroupRideService.confirmParticipantPickup(
        req.params.rideId,
        userId(req),
        req.params.participantId,
      );
      res.json(result);
    } catch (err) {
      fail(res, err);
    }
  }

  static async markPassengerNoShow(req: AuthRequest, res: Response) {
    try {
      if (!FriendsService.isUuid(req.params.rideId) || !FriendsService.isUuid(req.params.participantId)) {
        return res.status(400).json({ error: 'Invalid pickup request', code: 'INVALID_PICKUP' });
      }
      const result = await GroupRideService.markParticipantNoShow(
        req.params.rideId,
        userId(req),
        req.params.participantId,
      );
      res.json(result);
    } catch (err) {
      fail(res, err);
    }
  }

  static async friends(req: AuthRequest, res: Response) {
    try {
      const data = await FriendsService.list(userId(req));
      res.json(data);
    } catch (err) {
      fail(res, err);
    }
  }

  static async matchContacts(req: AuthRequest, res: Response) {
    try {
      const body = ContactsSchema.parse(req.body);
      const matches = await FriendsService.matchSelectedContacts(userId(req), body.contacts);
      res.json({ matches });
    } catch (err) {
      fail(res, err);
    }
  }

  static async requestFriend(req: AuthRequest, res: Response) {
    try {
      const body = FriendRequestSchema.parse(req.body);
      const result = body.userId
        ? await FriendsService.requestByUserId(userId(req), body.userId)
        : await FriendsService.requestByPhone(userId(req), body.phone!);
      res.status(201).json(result);
    } catch (err) {
      fail(res, err);
    }
  }

  static async respondFriend(req: AuthRequest, res: Response) {
    try {
      if (!FriendsService.isUuid(req.params.friendshipId)) {
        return res.status(400).json({ error: 'Invalid friend request', code: 'INVALID_FRIEND_REQUEST' });
      }
      const body = FriendRespondSchema.parse(req.body);
      const result = await FriendsService.respond(userId(req), req.params.friendshipId, body.accept);
      res.json(result);
    } catch (err) {
      fail(res, err);
    }
  }

  static async removeFriend(req: AuthRequest, res: Response) {
    try {
      if (!FriendsService.isUuid(req.params.userId)) {
        return res.status(400).json({ error: 'Invalid friend', code: 'INVALID_FRIEND' });
      }
      await FriendsService.remove(userId(req), req.params.userId);
      res.json({ removed: true });
    } catch (err) {
      fail(res, err);
    }
  }
}
