import type { DbTxUnion } from "./db.ts";
import type { IInviteRepository } from "./invite.ts";
import type { IRoleRepository } from "./roles.ts";
import type { IUserRepository } from "./users.ts";
import { RoleRepository } from "../prisma/roles.ts";
import { InviteRepository } from "../prisma/invite.ts";
import { UserRepository } from "../prisma/users.ts";
import { OutboxRepository, type IOutboxRepository } from "./outbox.ts";

export interface Repos {
    invite: IInviteRepository;
    role: IRoleRepository;
    user: IUserRepository;
    outbox: IOutboxRepository;
}

export interface IRepoFactory {
    buildRepos(db: DbTxUnion): Repos;
}

class RepoFactory implements IRepoFactory {
    buildRepos(db: DbTxUnion): Repos {
        return {
            invite: new InviteRepository(db),
            role: new RoleRepository(db),
            user: new UserRepository(db),
            outbox: new OutboxRepository(db),
        };
    }
}

export const repoFactory = new RepoFactory();