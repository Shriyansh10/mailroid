import {authClient} from '@web/lib/auth-client'

export const getSession = async () => {
    const session = await authClient.useSession();
    return session;
}
