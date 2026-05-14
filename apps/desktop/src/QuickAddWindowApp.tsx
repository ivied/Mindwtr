import { QuickAddModal } from './components/QuickAddModal';

export function QuickAddWindowApp() {
    return (
        <div className="h-full bg-background text-foreground">
            <QuickAddModal standaloneWindow />
        </div>
    );
}
