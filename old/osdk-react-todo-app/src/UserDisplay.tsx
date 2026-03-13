import { useUser } from "@bobbyfidz/osdk-react/users";
import { UserAvatar } from "./UserAvatar";

export interface UserDisplayProps {
    userId: string;
}

export const UserDisplay: React.FC<UserDisplayProps> = ({ userId }) => {
    const { data: user } = useUser(userId);

    const displayName = user
        ? [user.givenName, user.familyName].filter((name) => name !== undefined).join(" ")
        : "Unknown user";

    return (
        <div className="flex items-center gap-2">
            <UserAvatar userId={userId} />
            <span className="font-medium">{displayName}</span>
        </div>
    );
};
