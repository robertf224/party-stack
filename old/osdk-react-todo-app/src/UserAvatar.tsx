import { User, useUser, useUserProfilePicture } from "@bobbyfidz/osdk-react/users";
import { Suspense } from "react";

export const UserAvatar: React.FC<{ userId: string }> = ({ userId }) => {
    const { data: user } = useUser(userId);
    return (
        <Suspense fallback={<UserInitials user={user ?? undefined} />}>
            {user ? <UserProfilePicture user={user} /> : <UserInitials />}
        </Suspense>
    );
};

const UserProfilePicture: React.FC<{ user: User }> = ({ user }) => {
    const { data: avatarUrl } = useUserProfilePicture(user.id);
    return avatarUrl ? (
        <div className="h-8 w-8 overflow-hidden rounded-full">
            <img
                src={avatarUrl}
                className="animate-fade-in h-full w-full object-cover opacity-0 transition-opacity duration-300 ease-in-out"
                onLoad={(e) => e.currentTarget.classList.remove("opacity-0")}
            />
        </div>
    ) : (
        <UserInitials user={user} />
    );
};

export const UserInitials: React.FC<{ user?: User }> = ({ user }) => {
    const names = user ? [user.givenName, user.familyName].filter((name) => name !== undefined) : ["Unknown"];
    const initials = names
        .map((name) => name[0])
        .join("")
        .toUpperCase();

    return (
        <div className={`flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-gray-200`}>
            <span className="text-sm font-medium text-gray-600">{initials}</span>
        </div>
    );
};
